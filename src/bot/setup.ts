/** One-time Telegram setup behind POST /admin/setup: webhook, commands, menu button. */

import { GrammyError, type Api } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { buildWebappUrl } from "./keyboards";
import { describeError } from "./notifier";
import { BOT_COMMANDS, OPEN_APP_TEXT } from "./texts";

export const ALLOWED_UPDATES = ["message"] as const;

export interface SetupOptions {
  /** Public origin of this Worker, e.g. https://split-bot.example.workers.dev */
  origin: string;
  webhookSecret: string;
  webappUrl: string;
}

export interface SetupSummary {
  ok: true;
  bot_username: string;
  webhook_url: string;
  allowed_updates: string[];
  drop_pending_updates: true;
  commands: string[];
  menu_button: { text: string; url: string };
}

export class SetupError extends Error {
  constructor(
    readonly step: string,
    readonly detail: string,
  ) {
    super(`${step}: ${detail}`);
    this.name = "SetupError";
  }
}

async function step<T>(name: string, token: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const detail = err instanceof GrammyError ? err.description : describeError(err, token);
    throw new SetupError(name, detail);
  }
}

/** Returns a summary without secrets. `onBotInfo` receives the getMe result (to memoize it). */
export async function runSetup(
  api: Api,
  options: SetupOptions,
  onBotInfo?: (me: UserFromGetMe) => void,
): Promise<SetupSummary> {
  const webhookUrl = `${options.origin.replace(/\/+$/, "")}/tg/webhook`;
  const menuUrl = buildWebappUrl(options.webappUrl);
  const me = await step("getMe", api.token, () => api.getMe());
  onBotInfo?.(me);
  await step("setWebhook", api.token, () =>
    api.setWebhook(webhookUrl, {
      secret_token: options.webhookSecret,
      allowed_updates: [...ALLOWED_UPDATES],
      drop_pending_updates: true,
    }),
  );
  await step("setMyCommands", api.token, () => api.setMyCommands(BOT_COMMANDS.map((c) => ({ ...c }))));
  await step("setChatMenuButton", api.token, () =>
    api.setChatMenuButton({ menu_button: { type: "web_app", text: OPEN_APP_TEXT, web_app: { url: menuUrl } } }),
  );
  return {
    ok: true,
    bot_username: me.username,
    webhook_url: webhookUrl,
    allowed_updates: [...ALLOWED_UPDATES],
    drop_pending_updates: true,
    commands: BOT_COMMANDS.map((c) => `/${c.command}`),
    menu_button: { text: OPEN_APP_TEXT, url: menuUrl },
  };
}
