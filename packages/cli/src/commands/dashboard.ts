// packages/cli/src/commands/dashboard.ts
// `cassie dashboard [botId...]`: every bot on this machine in one browser tab.
// `cassie dashboard password <botId>`: set or rotate the hosted password.

import pc from "picocolors";
import type { BotConfig } from "@quotient-forecasting/cassie-core";
import { hashDashboardPassword } from "@quotient-forecasting/cassie-runtime-node";
import { ask, isDeployed, openUrl, targetFor } from "../context.js";
import { resolveLocalValue } from "../local-env.js";
import { listBotIds, loadBotConfig, safeBotId, saveBotConfig } from "../paths.js";
import { sshExec, sshExecOrThrow } from "../ssh.js";
import { remoteWriteCommand } from "../remote-write.js";
import { DEFAULT_DASHBOARD_PORT, authFilePath, dashboardAuthFile, dashboardUrl, requireDashboardPassword } from "../dashboard/provision.js";
import { createDashboardSources } from "../dashboard/sources.js";
import { startLocalDashboardServer } from "../dashboard/server.js";

export interface DashboardOpts {
  port: number;
  open: boolean;
  refresh: number;
}

export async function runDashboard(botIds: string[], opts: DashboardOpts): Promise<void> {
  const ids = botIds.length > 0 ? botIds.map(safeBotId) : listBotIds();
  for (const id of botIds) loadBotConfig(id); // an unknown id fails before the server starts
  if (ids.length === 0) {
    console.log("No bots configured.");
    console.log("cassie init");
    return;
  }
  const sources = createDashboardSources(ids, { refreshSeconds: opts.refresh });
  sources.start();
  const running = await startLocalDashboardServer({ port: opts.port, sources });
  console.log(`Dashboard: ${running.url}`);
  console.log(pc.dim(`${ids.length} ${ids.length === 1 ? "bot" : "bots"}, refresh every ${opts.refresh}s. Ctrl-C stops.`));
  if (opts.open) openUrl(running.url);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  sources.stop();
  await running.close();
}

export async function setDashboardPassword(botId: string): Promise<void> {
  const cfg = loadBotConfig(botId);
  const local = resolveLocalValue(["CASSIE_DASHBOARD_PASSWORD"]);
  let password: string;
  if (local) {
    console.log(pc.dim(`dashboard password: ${local.origin}`));
    password = local.value;
  } else {
    if (!process.stdin.isTTY) throw new Error("no dashboard password: set CASSIE_DASHBOARD_PASSWORD or run this in a terminal");
    password = await ask("Dashboard password", { secret: true });
    requireDashboardPassword(password);
    const confirmation = await ask("Confirm dashboard password", { secret: true });
    if (confirmation !== password) throw new Error("dashboard passwords do not match");
  }
  requireDashboardPassword(password);
  const passwordHash = await hashDashboardPassword(password);
  const next: BotConfig = {
    ...cfg,
    dashboard: { enabled: cfg.dashboard?.enabled ?? true, port: cfg.dashboard?.port ?? DEFAULT_DASHBOARD_PORT, passwordHash },
  };
  saveBotConfig(next);
  console.log("Password saved.");
  if (!isDeployed(next)) {
    console.log(`cassie deploy ${botId}`);
    return;
  }
  const target = targetFor(next);
  try {
    sshExecOrThrow(target, remoteWriteCommand(authFilePath(botId), "0600", "cassie:cassie"), dashboardAuthFile(passwordHash));
  } catch (error) {
    console.log(pc.yellow(`could not reach the droplet: ${(error as Error).message.slice(0, 200)}`));
    console.log(`cassie deploy ${botId}`);
    return;
  }
  console.log("Password updated on the droplet.");
  const provisioned = sshExec(target, `grep -q '^CASSIE_DASHBOARD_PORT=' /etc/cassie/${safeBotId(botId)}.env`);
  if (provisioned.ok) {
    console.log(dashboardUrl(next.deployment!.host, next.dashboard!.port));
  } else {
    console.log("The dashboard is not provisioned on this droplet.");
    console.log(`cassie deploy ${botId}`);
  }
}
