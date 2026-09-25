// packages/cli/src/webhook-settings.ts
// Alert webhook credentials. Order: nearest .local.env, exported environment,
// then the bot's keystore. The URL is treated as a secret: Slack and Discord
// webhook URLs grant posting rights to whoever holds them.

import { ALERT_KINDS, KeyRoles, WEBHOOK_FORMATS, type AlertKind, type WebhookFormat } from "@quotient-forecasting/cassie-core";
import { getKeystoreSecret } from "./context.js";
import { environmentValue, localEnvValue } from "./local-env.js";

export const WEBHOOK_URL_NAMES = ["CASSIE_WEBHOOK_URL"] as const;
export const WEBHOOK_SECRET_NAMES = ["CASSIE_WEBHOOK_SECRET"] as const;

export interface WebhookSettings {
  url?: string;
  secret?: string;
  /** Human-readable origins; never the values. */
  urlOrigin?: string;
  secretOrigin?: string;
}

export interface WebhookSettingsDeps {
  keystoreSecret: (botId: string, role: string) => Promise<string | null>;
}

const defaultDeps: WebhookSettingsDeps = { keystoreSecret: getKeystoreSecret };

/** Values available without unlocking a keystore. */
export function localWebhookSettings(startDir = process.cwd()): WebhookSettings {
  const url = localEnvValue(WEBHOOK_URL_NAMES, startDir) ?? environmentValue(WEBHOOK_URL_NAMES);
  const secret = localEnvValue(WEBHOOK_SECRET_NAMES, startDir) ?? environmentValue(WEBHOOK_SECRET_NAMES);
  return {
    ...(url ? { url: url.value, urlOrigin: url.origin } : {}),
    ...(secret ? { secret: secret.value, secretOrigin: secret.origin } : {}),
  };
}

/** Full chain for run, deploy and `cassie alerts test`. Local values win over the keystore. */
export async function resolveWebhookSettings(
  botId: string,
  startDir = process.cwd(),
  deps: WebhookSettingsDeps = defaultDeps,
): Promise<WebhookSettings> {
  const out = localWebhookSettings(startDir);
  if (!out.url) {
    const stored = await deps.keystoreSecret(botId, KeyRoles.webhookUrl);
    if (stored) {
      out.url = stored;
      out.urlOrigin = `bot ${botId} keystore entry ${KeyRoles.webhookUrl}`;
    }
  }
  if (!out.secret) {
    const stored = await deps.keystoreSecret(botId, KeyRoles.webhookSecret);
    if (stored) {
      out.secret = stored;
      out.secretOrigin = `bot ${botId} keystore entry ${KeyRoles.webhookSecret}`;
    }
  }
  return out;
}

/** One line for the operator. Never prints the URL or the secret. */
export function describeWebhookSettings(settings: WebhookSettings): string {
  if (!settings.url) return "Webhook alerts off: CASSIE_WEBHOOK_URL not set (nearest .local.env, environment, or cassie alerts webhook)";
  const signing = settings.secret ? `signed with the secret from ${settings.secretOrigin}` : "unsigned";
  return `Webhook: URL from ${settings.urlOrigin}; ${signing}`;
}

/** https everywhere; http only for loopback development receivers. */
export function checkWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("the webhook URL is not a valid URL");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("the webhook URL must use https (http is allowed for localhost only)");
  }
  if (url.username || url.password) throw new Error("the webhook URL must not contain credentials");
  return url.href;
}

export function parseWebhookFormat(raw: string | undefined): WebhookFormat | undefined {
  if (raw === undefined) return undefined;
  if (!(WEBHOOK_FORMATS as readonly string[]).includes(raw)) {
    throw new Error(`--format must be one of ${WEBHOOK_FORMATS.join(", ")}`);
  }
  return raw as WebhookFormat;
}

export function parseAlertKinds(raw: string | undefined): AlertKind[] | undefined {
  if (raw === undefined) return undefined;
  const kinds = [...new Set(raw.split(",").map((k) => k.trim()).filter(Boolean))];
  if (kinds.length === 0) throw new Error("--kinds needs at least one kind");
  const unknown = kinds.filter((k) => !(ALERT_KINDS as readonly string[]).includes(k));
  if (unknown.length) throw new Error(`unknown alert kind(s): ${unknown.join(", ")}. Kinds: ${ALERT_KINDS.join(", ")}`);
  return kinds as AlertKind[];
}
