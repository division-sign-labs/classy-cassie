// packages/cli/src/telegram-settings.ts
// Telegram alert settings. Order: nearest .local.env, exported environment, then the
// bot's keystore token and saved chat id. Operators who keep both values in
// .local.env never type them into the wizard; run, deploy and alert tests read them.

import { KeyRoles } from "@quotient-forecasting/cassie-core";
import { getKeystoreSecret } from "./context.js";
import { environmentValue, localEnvValue, type ResolvedLocalValue } from "./local-env.js";

export const TELEGRAM_TOKEN_NAMES = ["TELEGRAM_BOT_TOKEN"] as const;
/** A personal chat id. TELEGRAM_USER_ID is accepted because @userinfobot labels it that way. */
export const TELEGRAM_CHAT_ID_NAMES = ["TELEGRAM_CHAT_ID", "TELEGRAM_USER_ID"] as const;

export interface LocalTelegramSettings {
  token?: ResolvedLocalValue;
  chatId?: ResolvedLocalValue;
}

export interface TelegramSettings {
  token?: string;
  chatId?: string;
  /** Human-readable origins; never the values. */
  tokenOrigin?: string;
  chatIdOrigin?: string;
}

/** Values available without unlocking a keystore: nearest .local.env, then the exported environment. */
export function localTelegramSettings(startDir = process.cwd()): LocalTelegramSettings {
  const token = localEnvValue(TELEGRAM_TOKEN_NAMES, startDir) ?? environmentValue(TELEGRAM_TOKEN_NAMES);
  const chatId = localEnvValue(TELEGRAM_CHAT_ID_NAMES, startDir) ?? environmentValue(TELEGRAM_CHAT_ID_NAMES);
  return { ...(token ? { token } : {}), ...(chatId ? { chatId } : {}) };
}

/** Full chain for run, deploy and `cassie alerts test`: local values win over the bot's saved ones. */
export async function resolveTelegramSettings(
  botId: string,
  saved: { chatId: string } | undefined,
  startDir = process.cwd(),
): Promise<TelegramSettings> {
  const local = localTelegramSettings(startDir);
  const out: TelegramSettings = {};
  if (local.token) {
    out.token = local.token.value;
    out.tokenOrigin = local.token.origin;
  } else {
    const stored = await getKeystoreSecret(botId, KeyRoles.telegramToken);
    if (stored) {
      out.token = stored;
      out.tokenOrigin = `bot ${botId} keystore entry ${KeyRoles.telegramToken}`;
    }
  }
  if (local.chatId) {
    out.chatId = local.chatId.value;
    out.chatIdOrigin = local.chatId.origin;
  } else if (saved?.chatId) {
    out.chatId = saved.chatId;
    out.chatIdOrigin = `bot ${botId} config alerts.telegram.chatId`;
  }
  return out;
}

/** One line for the operator: where each value came from, or which one is missing. */
export function describeTelegramSettings(settings: TelegramSettings): string {
  if (!settings.token || !settings.chatId) {
    const missing = [settings.token ? null : "TELEGRAM_BOT_TOKEN", settings.chatId ? null : "TELEGRAM_CHAT_ID"]
      .filter((name): name is string => name !== null).join(" and ");
    return `Telegram alerts off: ${missing} not set (nearest .local.env, environment, or cassie init)`;
  }
  return `Telegram: token from ${settings.tokenOrigin}; chat id from ${settings.chatIdOrigin}`;
}

/** Map a Telegram API failure to advice without echoing the provider payload. */
export function describeTelegramFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /bot.*send.*bot/i.test(message)
    ? "Telegram rejected a bot chat ID. Use your personal chat ID."
    : /chat not found|blocked|initiate conversation/i.test(message)
    ? "Telegram cannot reach that chat. Check the chat ID and press Start in your alert bot."
    : /401|unauthorized/i.test(message)
    ? "Telegram rejected the token. Copy it from @BotFather."
    : "Telegram test failed. Check the token, chat ID and connection.";
}
