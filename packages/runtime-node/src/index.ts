// packages/runtime-node/src/index.ts
// Library surface. The process entry point is main.ts (bin: cassie-runtime).

export { BotService, buildAlerter, buildSignalSource, buildStrategy } from "./service.js";
export type { BotRuntimeOptions, RuntimeIdentity } from "./service.js";
export { SqliteStateStore } from "./state.js";
export { MarketMakeStateStore, marketMakeActivationHash } from "./market-make-state.js";
export type {
  MarketMakeLifecycle,
  MarketMakeStateStatus,
  MarketMakeOrder,
  MarketMakeInventoryCycle,
  MarketMakeReconcileSnapshotInput,
} from "./market-make-state.js";
export { MarketMakeController } from "./market-make-controller.js";
export type {
  MarketMakeControllerOptions,
  MarketMakeControllerStatus,
  MarketMakeDryRunResult,
  MarketMakeReconcileResult,
  MarketMakeTickResult,
} from "./market-make-controller.js";
export { handle, serveControl } from "./control.js";
export { dropletId, dropletRegion, requireRegion } from "./region.js";
export { nextTickAtMs, tickIdAt, tickIntervalSeconds } from "./tick-schedule.js";
export { buildLocalService, runLocal } from "./local.js";
export type { LocalRunOpts } from "./local.js";
