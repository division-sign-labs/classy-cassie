// packages/cli/src/commands/withdraw.ts
// `cassie withdraw <botId> <amount|all> --to <address>` — send collateral back
// out of a venue. Signs with the master/L1 key from the local keystore, so it
// runs on the machine that holds it; deployed bots cannot withdraw remotely.

import pc from "picocolors";
import {
  adapterFor,
  confirm,
  makeSetupContext,
  requireAccount,
} from "../context.js";
import { loadBotConfig } from "../paths.js";

export interface WithdrawDependencies {
  loadConfig: typeof loadBotConfig;
  requireAccount: typeof requireAccount;
  adapterFor: typeof adapterFor;
  makeSetupContext: typeof makeSetupContext;
  confirm: typeof confirm;
  log(message: string): void;
}

export interface WithdrawOptions {
  to?: string;
  yes?: boolean;
}

const DEFAULT_DEPS: WithdrawDependencies = {
  loadConfig: loadBotConfig,
  requireAccount,
  adapterFor,
  makeSetupContext,
  confirm,
  log: (message) => console.log(message),
};

export function createWithdrawHandler(
  overrides: Partial<WithdrawDependencies> = {},
): (botId: string, amountArg: string, opts: WithdrawOptions) => Promise<void> {
  const deps: WithdrawDependencies = { ...DEFAULT_DEPS, ...overrides };
  return async (botId, amountArg, opts) => {
    const cfg = deps.loadConfig(botId);
    const account = deps.requireAccount(cfg);
    // Before the EVM --to validation: a Kalshi withdrawal has no on-chain
    // destination at all, so the right error names the venue, not the flag.
    if (cfg.venue === "kalshi") {
      throw new Error("Kalshi withdrawals require Account → Withdraw on the website.\nhttps://kalshi.com");
    }
    if (!opts.to || !/^0x[0-9a-fA-F]{40}$/.test(opts.to)) {
      throw new Error("--to <address> required (0x… EVM address)");
    }
    const amount = amountArg.toLowerCase() === "all" ? ("all" as const) : Number(amountArg);
    if (amount !== "all" && !(amount > 0)) throw new Error("amount must be a positive number or 'all'");

    const adapter = await deps.adapterFor(cfg, { needCreds: false });
    if (!adapter.withdraw) {
      throw new Error(
        cfg.venue === "lighter"
          ? "Use the Lighter app with your L1 wallet to withdraw."
          : `withdraw is not supported on the ${cfg.venue} venue`,
      );
    }

    const destChain = cfg.venue === "hyperliquid" ? "Arbitrum" : cfg.venue === "polymarket" ? "Polygon (pUSD)" : cfg.venue;
    deps.log("Withdrawal");
    deps.log(`Bot: ${botId}`);
    deps.log(`Venue: ${cfg.venue}`);
    deps.log(`Amount: ${amount === "all" ? "entire balance" : amount}`);
    deps.log(`Destination: ${destChain}`);
    deps.log(opts.to);
    if (!opts.yes && !(await deps.confirm("Send withdrawal?", false))) return;

    const receipt = await adapter.withdraw(deps.makeSetupContext(botId), account, { to: opts.to, amount });
    deps.log(pc.green(receipt));
  };
}

const defaultWithdrawHandler = createWithdrawHandler();

export async function runWithdraw(botId: string, amountArg: string, opts: WithdrawOptions): Promise<void> {
  return defaultWithdrawHandler(botId, amountArg, opts);
}
