// packages/cli/src/cloudflare.ts
// Getting a first-time operator from "I have never touched Cloudflare" to "the
// worker is live", without making them read a wrangler stack trace.
//
// `cassie deploy` runs wrangler with piped stdio because it feeds secrets in on
// stdin. That means every interactive prompt wrangler wants to show degrades to
// its non-interactive fallback and turns into an error. So we do the setup
// steps ourselves first, handing the terminal to wrangler for the parts that
// need a human, and only then run the piped deploy.

import { spawnSync } from "node:child_process";
import pc from "picocolors";
import { ask, confirm, select } from "./context.js";

export type CloudflareStatus = { email: string | null; accounts: { name: string; id: string }[] };

function run(args: string[], cwd: string): { out: string; ok: boolean } {
  const res = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  return { out: (res.stdout ?? "") + (res.stderr ?? ""), ok: res.status === 0 };
}

/** Hand over the terminal so wrangler's own prompts reach the operator. Carries no secrets. */
function runInteractive(args: string[], cwd: string): boolean {
  const res = spawnSync("pnpm", ["exec", "wrangler", ...args], { cwd, stdio: "inherit", env: process.env });
  return res.status === 0;
}

/** Parse `wrangler whoami`. Account rows are a box-drawn table of name + 32-hex id. */
export function parseWhoami(out: string): CloudflareStatus {
  const email = out.match(/associated with the email ([^\s.]+@[^\s.]+\.[^\s]+?)\.?\s/)?.[1] ?? null;
  const accounts: { name: string; id: string }[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/│\s*(.+?)\s*│\s*([0-9a-f]{32})\s*│/);
    if (m?.[1] && m[2]) accounts.push({ name: m[1].trim(), id: m[2] });
  }
  return { email, accounts };
}

async function ensureLoggedIn(cwd: string): Promise<CloudflareStatus> {
  let status = parseWhoami(run(["whoami"], cwd).out);
  if (status.email && status.accounts.length > 0) return status;

  console.log(
    [
      "",
      pc.bold("First, cassie needs access to a Cloudflare account."),
      "Your bot runs in a Container behind a Worker on an account you own and pay for.",
      "Cloudflare Containers require the Workers Paid plan; enable it in the dashboard before deploying.",
      "cassie holds no infrastructure on your behalf — this is your account, your bill, your kill switch.",
      "",
    ].join("\n"),
  );

  const path = await select("Do you have a Cloudflare account?", [
    { title: "Yes — log me in", value: "login" },
    { title: "No — I need to make one", value: "signup" },
  ]);

  if (path === "signup") {
    console.log(
      [
        "",
        `Sign up here: ${pc.cyan("https://dash.cloudflare.com/sign-up")}`,
        "Create the account, then enable Workers Paid in the dashboard. No domain is required.",
        "",
      ].join("\n"),
    );
    await ask("Press Enter once you're signed up");
  }

  console.log(
    [
      "",
      "Opening your browser so Cloudflare can authorize this machine.",
      "Approve the request there, then come back — this window is waiting on it.",
      "",
    ].join("\n"),
  );
  if (!(await confirm("Open the browser now?", true))) {
    throw new Error("Cloudflare login is required to deploy. Run `pnpm exec wrangler login` when you're ready, then re-run `cassie deploy`.");
  }
  runInteractive(["login"], cwd);

  status = parseWhoami(run(["whoami"], cwd).out);
  if (!status.email || status.accounts.length === 0) {
    throw new Error(
      "still not logged in to Cloudflare after the browser step.\n" +
        "Try `pnpm exec wrangler login` on its own to see what it says, then re-run `cassie deploy`.",
    );
  }
  console.log(pc.green(`logged in as ${status.email}`));
  return status;
}

/** With several accounts, wrangler refuses to guess. Ask once and pin it for the child processes. */
async function ensureAccountSelected(status: CloudflareStatus): Promise<string> {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const only = status.accounts[0];
  const chosen =
    status.accounts.length === 1 && only
      ? only.id
      : await select(
          "Which Cloudflare account should this bot live in?",
          status.accounts.map((a) => ({ title: `${a.name} (${a.id})`, value: a.id })),
        );
  process.env.CLOUDFLARE_ACCOUNT_ID = chosen;
  return chosen;
}

/**
 * A brand-new account has no workers.dev subdomain, so there is nowhere to
 * publish to and the deploy fails. wrangler can register one, but only when it
 * can ask — so we replay the deploy with the terminal attached and let it.
 * Returns true if the operator got through it.
 */
export async function registerWorkersDevSubdomain(cwd: string, workerName: string, accountId: string): Promise<boolean> {
  console.log(
    [
      "",
      pc.bold("Your Cloudflare account needs a workers.dev subdomain."),
      "It's a one-time, free namespace that every Worker on your account is served under —",
      `this bot would land at ${pc.dim(`https://${workerName}.<your-subdomain>.workers.dev`)}.`,
      "",
      "It's shared with everyone on Cloudflare, so common words are taken. Something like",
      `${pc.dim("your-name-here")} works. Only you will ever type this URL.`,
      "",
      "wrangler asks for the name and checks availability — handing the terminal over now.",
      "",
    ].join("\n"),
  );
  if (!(await confirm("Continue?", true))) return false;

  const ok = runInteractive(["deploy", "--name", workerName], cwd);
  if (!ok) {
    console.log(
      [
        "",
        pc.yellow("That didn't complete."),
        `You can also pick a subdomain in the dashboard: ${pc.cyan(`https://dash.cloudflare.com/${accountId}/workers/subdomain`)}`,
        "Once it's set, re-run `cassie deploy` and it'll pick up from here.",
        "",
      ].join("\n"),
    );
  }
  return ok;
}

/** Run before anything touches the keystore, so setup questions come before the passphrase prompt. */
export async function ensureCloudflareReady(cwd: string): Promise<{ accountId: string }> {
  const status = await ensureLoggedIn(cwd);
  const accountId = await ensureAccountSelected(status);
  return { accountId };
}
