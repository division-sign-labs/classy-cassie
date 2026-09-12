// packages/cli/src/commands/swing.ts
// Live swing operations and offline replay of receipt-time market recordings.
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { parseBotConfig, type BotConfig } from "@quotient-forecasting/cassie-core";
import { buildLocalService, SqliteStateStore, SwingRecordingStore, swingResearchHash } from "@quotient-forecasting/cassie-runtime-node";
import { QuotientSwingConfigSchema, replaySwing } from "@quotient-forecasting/strategy-quotient-swing";
import { confirm, controlFetch, requireAccount } from "../context.js";
import { dirs, loadBotConfig, saveBotConfig, statePath } from "../paths.js";
import { resolveQuotientToken } from "../quotient-token.js";

function requireSwing(botId: string): BotConfig {
  const cfg = loadBotConfig(botId);
  if (cfg.venue !== "hyperliquid" || cfg.strategy.id !== "quotient-swing") throw new Error("this command requires a Hyperliquid quotient-swing bot");
  return cfg;
}
function socketPath(botId: string): string { return join(dirs.run(), `${botId}.sock`); }
function reachable(cfg: BotConfig): boolean { return Boolean(cfg.deployment) || existsSync(socketPath(cfg.id)); }
function print(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }

export function swingControl(cfg: BotConfig, path: string, method: "GET" | "POST" = "GET", value?: unknown): Promise<unknown> {
  const body = value === undefined ? undefined : JSON.stringify(value);
  if (cfg.deployment) return controlFetch(cfg, path, { method, body });
  if (!existsSync(socketPath(cfg.id))) throw new Error(`Local runtime not running. Start it in another terminal.\ncassie run ${cfg.id}`);
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socketPath(cfg.id), path, method,
      headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : undefined }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 16 * 1024 * 1024) req.destroy(new Error("swing response exceeds 16 MiB; use a narrower replay range")); else chunks.push(chunk); });
      response.on("end", () => {
        try {
          const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if ((response.statusCode ?? 500) >= 400) reject(new Error(JSON.stringify(result)));
          else resolve(result);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(300_000, () => req.destroy(new Error("swing control request timed out; check status and logs before retrying")));
    req.on("error", reject); req.end(body);
  });
}

export function configureSwing(botId: string, opts: { config?: string }): void {
  const cfg = loadBotConfig(botId);
  if (cfg.venue !== "hyperliquid") throw new Error("quotient-swing requires Hyperliquid");
  if (reachable(cfg)) throw new Error("stop the local runtime before changing swing configuration; deployed configurations must be changed through a reviewed deployment workflow");
  if (cfg.strategy.id !== "quotient-swing" && existsSync(statePath(botId))) throw new Error("existing strategy state belongs to this bot id; create a new bot id for quotient-swing");
  const supplied: unknown = opts.config ? JSON.parse(readFileSync(opts.config, "utf8")) : cfg.strategy.id === "quotient-swing" ? cfg.strategy.config : {};
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw new Error("strategy config must be a JSON object");
  const config = QuotientSwingConfigSchema.parse(supplied);
  saveBotConfig(parseBotConfig({ ...cfg, tickIntervalMin: config.tickIntervalMin, strategy: { id: "quotient-swing", config } }));
  console.log("Quotient swing configured.");
  console.log(`Planned stop risk: ${config.riskBasePct}–${config.riskMaxPct}% of NAV.`);
  console.log(`Isolated margin: new entries share the unused ${config.totalMarginPct}% of NAV budget, at most ${config.singleMarginPct}% each; gross exposure limit ${config.grossNotionalNav}× NAV.`);
  if (config.reservedAssets.length) console.log(`Reserved slots: ${config.reservedAssets.join(", ")}.`);
  console.log("Running or deploying starts live trading.");
}
export async function swingStatus(botId: string): Promise<void> {
  const cfg = requireSwing(botId);
  if (reachable(cfg)) { print(await swingControl(cfg, "/swing/status")); return; }
  const state = new SqliteStateStore(statePath(botId));
  try {
    const [execution, report] = await Promise.all([state.get("perp:execution:v1"), state.get("strategy:quotient-swing:report")]);
    print({ running: false, strategy: "quotient-swing", execution: execution ? JSON.parse(execution) as unknown : null,
      lastReport: report ? JSON.parse(report) as unknown : null });
  } finally { state.close(); }
}
export async function swingDryRun(botId: string): Promise<void> {
  const cfg = requireSwing(botId);
  if (reachable(cfg)) { print(await swingControl(cfg, "/swing/dry-run", "POST")); return; }
  const quotientToken = (await resolveQuotientToken(botId))?.token;
  const service = buildLocalService({ config: cfg, account: requireAccount(cfg), statePath: statePath(botId), quotientToken });
  try { print(await service.swingDryRun()); } finally { await service.shutdown(false); }
}
export async function swingHalt(botId: string): Promise<void> {
  print(await swingControl(requireSwing(botId), "/swing/halt", "POST"));
  console.log("Entries halted; working entries canceled.");
  console.log("Position supervision and native stops remain active. Resume with: cassie swing resume <botId>");
}
export async function swingResume(botId: string, opts: { acknowledgeLossReset?: boolean } = {}): Promise<void> {
  const cfg = requireSwing(botId);
  print(await swingControl(cfg, "/swing/status"));
  if (opts.acknowledgeLossReset && !(await confirm("Reset the drawdown high-water mark after reviewing the losses?", false))) return;
  print(await swingControl(cfg, "/swing/resume", "POST", { confirmed: true, acknowledgeLossReset: opts.acknowledgeLossReset === true }));
}
export async function swingReplay(botId: string, opts: { from?: string; until?: string; costs?: string; fillModel?: string } = {}): Promise<void> {
  const cfg = requireSwing(botId), config = QuotientSwingConfigSchema.parse(cfg.strategy.config);
  const from = opts.from ? Date.parse(opts.from) : 0, until = opts.until ? Date.parse(opts.until) : Date.now();
  const costMultiplier = Number(opts.costs ?? 1), fillModel = opts.fillModel ?? "cross";
  if (!Number.isFinite(from) || !Number.isFinite(until) || from >= until || !Number.isFinite(costMultiplier) || costMultiplier < 1 || !["cross", "touch"].includes(fillModel)) throw new Error("invalid replay range, costs (minimum 1), or fill model (cross/touch)");
  if (reachable(cfg)) { print(await swingControl(cfg, "/swing/replay", "POST", { from, until, costMultiplier, fillModel })); return; }
  const recordings = new SwingRecordingStore(`${statePath(botId)}.swing.sqlite`);
  try { print(replaySwing(recordings.read(swingResearchHash(config), "live", from, until), config, { costMultiplier, fillModel: fillModel as "cross" | "touch" })); }
  finally { recordings.close(); }
}
