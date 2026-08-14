// packages/cli/src/splits-init.ts
// Resumable creation of one organization-owned Splits subaccount. This never
// changes an existing account and never reads or persists Splits credentials.

import type { BotConfig, SplitsTreasury } from "@quotient-forecasting/cassie-core";
import {
  SplitsCli,
  type CreateSplitsAccountInput,
  type SplitsAccount,
  type SplitsAccountSigners,
  type SplitsOrganization,
} from "./splits.js";
import type { PendingSplitsAccount } from "./init-state.js";

export interface SplitsInitUi {
  confirm(message: string, defaultYes?: boolean): Promise<boolean>;
  select(message: string, choices: Array<{ value: string; title: string; description?: string }>): Promise<string>;
  print(message: string): void;
}

export interface SplitsInitInput {
  botId: string;
  venue: BotConfig["venue"];
  walletAddress: string;
  pending?: PendingSplitsAccount;
  cli?: SplitsCli;
  ui: SplitsInitUi;
  checkpointPending(pending: PendingSplitsAccount): void;
  wait?: (milliseconds: number) => Promise<void>;
}

function normalizedIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  const left = normalizedIds(actual);
  const right = normalizedIds(expected);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function signersMatch(signers: SplitsAccountSigners, pending: PendingSplitsAccount): boolean {
  return (
    signers.threshold === pending.threshold &&
    sameIds(
      signers.passkeySigners.filter((signer) => !signer.isArchived).map((signer) => signer.id),
      pending.passkeyIds,
    ) &&
    sameIds(
      signers.eoaSigners.map((signer) => signer.id),
      pending.eoa ? [pending.eoa.id] : [],
    )
  );
}

function toTreasury(org: SplitsOrganization, account: SplitsAccount, pending: PendingSplitsAccount): SplitsTreasury {
  return {
    provider: "splits",
    organizationId: org.orgId,
    organizationName: org.orgName,
    accountId: account.id,
    accountAddress: account.address,
    accountName: account.name ?? pending.accountName,
    signers: {
      passkeyIds: normalizedIds(pending.passkeyIds),
      ...(pending.eoa ? { eoa: pending.eoa } : {}),
    },
    threshold: pending.threshold,
  };
}

async function reconcile(
  cli: SplitsCli,
  org: SplitsOrganization,
  pending: PendingSplitsAccount,
): Promise<SplitsTreasury | null> {
  const named = (await cli.listAccounts()).filter(
    (account) => !account.isArchived && account.name === pending.accountName,
  );
  const verified: SplitsAccount[] = [];
  const mismatched: SplitsAccount[] = [];
  for (const account of named) {
    const signers = await cli.getAccountSigners(account.address);
    (signersMatch(signers, pending) ? verified : mismatched).push(account);
  }
  if (mismatched.length > 0) {
    throw new Error(
      `Splits already has ${mismatched.length} account${mismatched.length === 1 ? "" : "s"} named "${pending.accountName}" with a different signer set. ` +
        "Resolve or rename it in the Splits dashboard before resuming; Cassie will not mutate or duplicate it.",
    );
  }
  if (verified.length > 1) {
    throw new Error(
      `Splits has ${verified.length} matching accounts named "${pending.accountName}". Choose the intended account in the dashboard before resuming; Cassie will not guess.`,
    );
  }
  return verified[0] ? toTreasury(org, verified[0], pending) : null;
}

async function createAndVerify(
  cli: SplitsCli,
  org: SplitsOrganization,
  pending: PendingSplitsAccount,
  checkpointPending: (pending: PendingSplitsAccount) => void,
  wait: (milliseconds: number) => Promise<void>,
): Promise<SplitsTreasury> {
  const input: CreateSplitsAccountInput = {
    name: pending.accountName,
    passkeyIds: pending.passkeyIds,
    eoaSignerIds: pending.eoa ? [pending.eoa.id] : [],
    threshold: pending.threshold,
  };
  const attempted: PendingSplitsAccount = { ...pending, phase: "create-attempted" };
  // The checkpoint must reach disk before the non-idempotent POST. If the
  // response is lost, a later run will reconcile but never silently reissue.
  checkpointPending(attempted);
  let account: SplitsAccount;
  try {
    account = await cli.createAccount(input);
  } catch (error) {
    // Account creation is not idempotent and org reads may be eventually
    // consistent. Poll before declaring the outcome ambiguous.
    let lastReconcileError: unknown;
    for (const delay of [0, 500, 1_000, 2_000, 4_000, 8_000]) {
      if (delay > 0) await wait(delay);
      try {
        const recovered = await reconcile(cli, org, attempted);
        if (recovered) return recovered;
        lastReconcileError = undefined;
      } catch (reconcileError) {
        lastReconcileError = reconcileError;
      }
    }
    if (lastReconcileError) {
      throw new Error(
        `Splits account creation did not complete cleanly (${(error as Error).message}). ` +
          `Its outcome could not be reconciled (${(lastReconcileError as Error).message}). ` +
          "Do not create another account manually; rerun `cassie init` after checking the dashboard.",
      );
    }
    throw new Error(
      `Splits account creation has an ambiguous outcome (${(error as Error).message}). ` +
        `No matching account was visible after polling. Check the dashboard, then rerun \`cassie init\`; ` +
        "Cassie will require explicit confirmation before any retry.",
    );
  }

  const signers = await cli.getAccountSigners(account.address);
  if (!signersMatch(signers, pending)) {
    throw new Error(
      `Splits created ${account.address}, but its signer set did not match the confirmed plan. ` +
        "Cassie stopped without changing it; inspect the account in the Splits dashboard.",
    );
  }
  return toTreasury(org, account, pending);
}

async function choosePlan(input: SplitsInitInput, cli: SplitsCli, org: SplitsOrganization): Promise<PendingSplitsAccount> {
  const members = await cli.listMembers();
  if (members.length === 0) throw new Error("the authenticated Splits organization has no members");
  const userId = await input.ui.select(
    "Which Splits member are you?",
    members.map((member) => ({
      value: member.userId,
      title: member.displayName ?? member.email ?? member.userId,
      description: `${member.role}${member.email ? ` · ${member.email}` : ""}`,
    })),
  );
  const member = members.find((candidate) => candidate.userId === userId);
  if (!member) throw new Error("selected Splits member was not returned by the organization");
  const passkeys = (await cli.listMemberSigners(userId)).filter((signer) => !signer.isArchived);
  if (passkeys.length === 0) {
    throw new Error(`Splits member ${member.email ?? userId} has no active passkey; add one in the Splits dashboard first`);
  }
  const passkeyId = await input.ui.select(
    "Which passkey should be able to approve this account?",
    passkeys.map((signer) => ({
      value: signer.id,
      title: signer.name ?? `Passkey ${signer.id.slice(0, 8)}`,
      description: signer.id,
    })),
  );
  const selectedPasskey = passkeys.find((signer) => signer.id === passkeyId);
  if (!selectedPasskey) throw new Error("selected passkey was not returned by the chosen Splits member");
  input.ui.print(
    `Selected passkey: ${selectedPasskey.name ?? "unnamed passkey"} (${passkeyId}) · ${member.displayName ?? member.email ?? member.userId}`,
  );

  let eoa: PendingSplitsAccount["eoa"];
  if (input.venue === "polymarket") {
    input.ui.print(
      "Polymarket safety gate: the bot EOA will not be a Splits signer because its raw trading key is currently deployed to the runtime.",
    );
  } else if (
    await input.ui.confirm(
      "Also make Cassie's local master EOA an equal 1-of-2 signer on this subaccount? Either it or your passkey could move these funds alone. (advanced; Cassie does not sign Splits proposals yet)",
      false,
    )
  ) {
    const registered = await cli.registerEoaSigner(input.walletAddress, `cassie-${input.botId}`);
    if (registered.address.toLowerCase() !== input.walletAddress.toLowerCase()) {
      throw new Error("Splits returned a different address for the registered Cassie signer");
    }
    eoa = { id: registered.id, address: registered.address };
  }

  return {
    phase: "planned",
    organizationId: org.orgId,
    organizationName: org.orgName,
    accountName: `cassie-${input.botId}`,
    passkeyIds: [passkeyId],
    ...(eoa ? { eoa } : {}),
    // Cassie's funding handoff currently relies on web/passkey approval. Do
    // not offer 2-of-2 until Cassie has a safe local Splits signing path.
    threshold: 1,
  };
}

async function verifyPendingPlan(
  input: SplitsInitInput,
  cli: SplitsCli,
  pending: PendingSplitsAccount,
): Promise<void> {
  const members = await cli.listMembers();
  const labels = new Map<string, string>();
  for (const member of members) {
    const signers = await cli.listMemberSigners(member.userId);
    for (const signer of signers) {
      if (!signer.isArchived) {
        labels.set(
          signer.id,
          `${signer.name ?? "unnamed passkey"} · ${member.displayName ?? member.email ?? member.userId}`,
        );
      }
    }
  }
  const missing = pending.passkeyIds.filter((id) => !labels.has(id));
  if (missing.length > 0) {
    throw new Error(`checkpointed Splits passkey${missing.length === 1 ? " is" : "s are"} no longer active: ${missing.join(", ")}`);
  }
  if (pending.eoa) {
    if (input.venue === "polymarket" || pending.eoa.address.toLowerCase() !== input.walletAddress.toLowerCase()) {
      throw new Error("checkpointed Splits EOA is not safe for this bot wallet");
    }
    const registered = await cli.registerEoaSigner(input.walletAddress, `cassie-${input.botId}`);
    if (
      registered.id !== pending.eoa.id ||
      registered.address.toLowerCase() !== pending.eoa.address.toLowerCase()
    ) {
      throw new Error("checkpointed Splits EOA no longer matches the registered signer");
    }
  }

  input.ui.print(`Checkpointed account: ${pending.accountName}`);
  for (const id of pending.passkeyIds) input.ui.print(`Checkpointed passkey: ${id} (${labels.get(id)})`);
  input.ui.print(`Checkpointed Cassie EOA: ${pending.eoa ? `${pending.eoa.id} (${pending.eoa.address})` : "none"}`);
  input.ui.print(`Checkpointed threshold: ${pending.threshold}`);
  if (!(await input.ui.confirm("Resume exactly this Splits account plan?", true))) {
    throw new Error("operator declined the checkpointed Splits account plan");
  }
}

/** Create or safely recover the one new subaccount described by the journal. */
export async function createSplitsTreasury(input: SplitsInitInput): Promise<SplitsTreasury> {
  const cli = input.cli ?? new SplitsCli();
  const org = await cli.whoAmI();
  if (!org.scopes.some((scope) => scope.toLowerCase() === "owner")) {
    throw new Error(
      `Splits key "${org.keyName}" for ${org.orgName ?? org.orgId} lacks owner scope, which is required to create a subaccount`,
    );
  }
  input.ui.print(`Splits organization: ${org.orgName ?? "(unnamed)"} (${org.orgId})`);

  if (input.pending) {
    if (input.pending.organizationId !== org.orgId) {
      throw new Error(
        `the init checkpoint belongs to Splits org ${input.pending.organizationId}, but the active API key belongs to ${org.orgId}`,
      );
    }
    await verifyPendingPlan(input, cli, input.pending);
    const recovered = await reconcile(cli, org, input.pending);
    if (recovered) return recovered;
    if (input.pending.phase === "create-attempted") {
      input.ui.print(
        `A previous create request for "${input.pending.accountName}" may have committed, but no exact account is currently visible.`,
      );
      input.ui.print("Check the Splits dashboard before authorizing a retry; delayed visibility could otherwise create a duplicate.");
      if (!(await input.ui.confirm("I checked the dashboard; retry this exact create request?", false))) {
        throw new Error("Splits create remains unresolved; no retry was sent");
      }
    } else {
      input.ui.print(`No committed "${input.pending.accountName}" account was found; resuming before its first create request.`);
    }
    return createAndVerify(
      cli,
      org,
      input.pending,
      input.checkpointPending,
      input.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    );
  }

  if (!(await input.ui.confirm("Create a new isolated subaccount in this organization?", true))) {
    throw new Error("operator declined Splits subaccount creation");
  }
  const pending = await choosePlan(input, cli, org);
  input.ui.print(`Account: ${pending.accountName}`);
  input.ui.print(`Passkey signer: ${pending.passkeyIds.join(", ")}`);
  input.ui.print(`Cassie EOA signer: ${pending.eoa ? pending.eoa.address : "none"}`);
  if (pending.eoa) {
    input.ui.print("Authority: either the selected passkey or this EOA can move this subaccount's funds alone; neither gains access to sibling accounts.");
  }
  input.ui.print(`Threshold: ${pending.threshold}`);
  if (!(await input.ui.confirm("Create exactly this account?", true))) {
    throw new Error("operator declined the confirmed Splits account plan");
  }

  input.checkpointPending(pending);
  const existing = await reconcile(cli, org, pending);
  if (existing) {
    input.ui.print(`An exact active account named "${pending.accountName}" already exists at ${existing.accountAddress}.`);
    if (await input.ui.confirm("Link that exact existing account instead of creating a duplicate?", true)) return existing;
    throw new Error("Cassie will not create a duplicate same-name Splits account");
  }
  return createAndVerify(
    cli,
    org,
    pending,
    input.checkpointPending,
    input.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  );
}
