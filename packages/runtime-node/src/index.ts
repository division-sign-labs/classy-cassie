// packages/runtime-node/src/index.ts
// Library surface. The process entry point is main.ts (bin: cassie-runtime).

export { BotService, buildAlerter, buildSignalSource, buildStrategy } from "./service.js";
export type { BotRuntimeOptions, RuntimeIdentity } from "./service.js";
export { SqliteStateStore } from "./state.js";
export { handle, serveControl } from "./control.js";
export { dropletId, dropletRegion, requireRegion } from "./region.js";
export { nextTickAtMs, tickIdAt, tickIntervalSeconds } from "./tick-schedule.js";
export { buildLocalService, runLocal } from "./local.js";
export type { LocalRunOpts } from "./local.js";
