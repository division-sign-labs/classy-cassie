// packages/runtime-node/src/index.ts
// Library surface. The process entry point is main.ts (bin: cassie-runtime).

export { BotService, buildAlerter, buildSignalSource, buildStrategy } from "./service.js";
export type { BotRuntimeOptions, RuntimeIdentity } from "./service.js";
export { SqliteStateStore } from "./state.js";
export type { EquitySampleRow, MetricHourRow, MetricSampleRow, MetricTotalRow } from "./state.js";
export { CommodityDataSource } from "./commodity-data.js";
export { CommodityRecordingStore } from "./commodity-recordings.js";
export { SwingController } from "./swing-controller.js";
export { SwingRecordingStore, swingResearchHash } from "./swing-recordings.js";
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
export type {
  DashboardBotEntry,
  DashboardRange,
  DashboardSnapshot,
  EngineMetrics,
  EquityPoint,
  HistorySummary,
  MetricRow,
} from "./dashboard/types.js";
export { DASHBOARD_RANGES } from "./dashboard/types.js";
export {
  DashboardSnapshotCache,
  buildDashboardSnapshot,
  downsample,
  offlineDashboardSnapshot,
  parseDashboardRange,
  rangeSince,
  summarizeHistory,
} from "./dashboard/snapshot.js";
export type { DashboardServiceView, OfflineSnapshotInput } from "./dashboard/snapshot.js";
export { DashboardSampler, dashboardSampleMinutesFromEnv, equitySampleFromPortfolio } from "./dashboard/sampler.js";
export type { DashboardSamplerDeps, DashboardSamplerStatus } from "./dashboard/sampler.js";
export { CountingAlerter, EngineCounters } from "./dashboard/counters.js";
export { hashDashboardPassword, parseDashboardAuthFile, verifyDashboardPassword } from "./dashboard/password.js";
export { DASHBOARD_CSP, applySecurityHeaders, dashboardAsset, serveStatic } from "./dashboard/assets.js";
export type { DashboardAssetName } from "./dashboard/assets.js";
export {
  LoginRateLimiter,
  SessionStore,
  createDashboardHandler,
  fileDashboardAuth,
  loadDashboardTls,
  parseCookies,
  singleBotSource,
  startDashboardServer,
} from "./dashboard/server.js";
export type {
  DashboardAuth,
  DashboardBotSource,
  DashboardHandlerOptions,
  DashboardServerOptions,
  RunningDashboardServer,
} from "./dashboard/server.js";
