// packages/cli/src/commands/destroy.ts
// `cassie destroy <botId>`: stop the bot, cancel what it has resting, and
// delete the droplet. Keys and funds are untouched — they never lived here.

import pc from "picocolors";
import { confirm } from "../context.js";
import { loadBotConfig, saveBotConfig } from "../paths.js";
import { DigitalOcean, ensureDigitalOceanReady } from "../digitalocean.js";
import { controlCall, forgetHostKey, sshExec, type Target } from "../ssh.js";
import { firewallName } from "./deploy.js";

export interface DestroyOpts {
  yes?: boolean;
  /** Delete the droplet without trying to stop the bot cleanly first. */
  force?: boolean;
}

export async function runDestroy(botId: string, opts: DestroyOpts = {}): Promise<void> {
  const cfg = loadBotConfig(botId);
  const deployment = cfg.deployment;
  if (!deployment) {
    console.log(`${botId} is not deployed`);
    return;
  }

  const target: Target = { host: deployment.host, user: deployment.user };
  console.log(pc.bold(`destroying droplet cassie-${botId} in ${deployment.region} (${deployment.host})`));
  console.log(pc.dim("Resting orders are canceled first. The keystore and your venue balance stay as they are."));
  if (!opts.yes && !(await confirm("Destroy it?", false))) return;

  if (!opts.force && sshExec(target, "true").ok) {
    try {
      controlCall(target, botId, "POST", "/shutdown");
      console.log(pc.green("bot stopped, resting orders canceled"));
    } catch (error) {
      console.log(pc.yellow(`clean stop failed: ${(error as Error).message.slice(0, 160)}`));
      if (!(await confirm("Delete the droplet anyway?", false))) return;
    }
    sshExec(target, `systemctl disable --now cassie@${botId} || true`);
  }

  const { client } = await ensureDigitalOceanReady();
  await deleteDroplet(client, deployment.dropletId);
  await client.deleteFirewall(firewallName(botId)).catch(() => undefined);
  forgetHostKey(deployment.host);

  const { deployment: _dropped, ...rest } = cfg;
  saveBotConfig(rest);
  console.log(pc.green(`droplet deleted. run \`cassie run ${botId}\` locally, or \`cassie deploy ${botId}\` for a new one.`));
}

async function deleteDroplet(client: DigitalOcean, id: number): Promise<void> {
  try {
    await client.deleteDroplet(id);
  } catch (error) {
    // A droplet already gone from the dashboard should not block clearing config.
    console.log(pc.yellow(`droplet ${id}: ${(error as Error).message.slice(0, 160)}`));
  }
}
