// packages/runtime-node/src/local.ts
// `cassie run <botId>`: the same service the droplet runs, without the region
// gate. Ctrl-C cancels resting orders; the venue-side dead man's switch covers
// a hard kill.

import { consoleLogger, type BotConfig, type Logger, type RuntimeCreds, type VenueAccount } from "@quotient-forecasting/cassie-core";
import { BotService } from "./service.js";
import { serveControl } from "./control.js";

export interface LocalRunOpts {
  config: BotConfig;
  account: VenueAccount;
  creds?: RuntimeCreds;
  statePath: string;
  /** Contributor-test hook for a deterministic signal file. */
  signalsFixturePath?: string;
  quotientToken?: string;
  telegramToken?: string;
  /** Reporting provider key (e.g. ares_sk_live_…). Absent = attribute orders, report nothing. */
  reportingApiKey?: string;
  /** Surplus Intelligence key. Required by the agent strategy only. */
  surplusApiKey?: string;
  fixtureBooksPath?: string;
  log?: Logger;
  /** Control socket for another terminal to reach this process. Omit for none. */
  controlSocket?: string;
  /** Test hook: run at most N ticks then return. */
  maxTicks?: number;
}

export function buildLocalService(opts: LocalRunOpts): BotService {
  return new BotService({ ...opts, runtime: "local" });
}

/** Run the bot until SIGINT (or maxTicks, for tests). */
export async function runLocal(opts: LocalRunOpts): Promise<void> {
  const log = opts.log ?? consoleLogger(opts.config.id);
  const service = buildLocalService({ ...opts, log });
  const server = opts.controlSocket ? serveControl(service, opts.controlSocket) : undefined;

  if (opts.maxTicks !== undefined) {
    for (let i = 0; i < opts.maxTicks; i++) {
      await service.tick().catch((error) => log.error(`tick crashed: ${(error as Error).message}`));
    }
    await service.shutdown(false);
    server?.close();
    return;
  }

  await service.start();

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      log.info("shutting down: canceling resting orders…");
      await service.shutdown(true).catch((error) => log.warn(`shutdown failed: ${(error as Error).message}`));
      server?.close();
      resolve();
      process.exit(0);
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  });
}
