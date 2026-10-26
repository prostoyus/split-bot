/**
 * grammY bot in webhook mode, created lazily once per isolate (keyed by token + webhook secret + username).
 *
 * No getMe per request:
 * - with BOT_USERNAME set, botInfo is built locally (id = numeric prefix of the token), so the bot
 *   never calls getMe at all;
 * - otherwise getMe is called once per isolate and memoized (failures are retried no more than once a minute).
 *
 * Webhook flow: the secret is checked by the caller, then the update is parsed, Telegram gets 200
 * immediately and `bot.handleUpdate` runs inside `ctx.waitUntil` (so nothing is cut off after the
 * response). Per-request dependencies (D1, a waitUntil-based notifier) cannot live in the memoized bot,
 * so a RequestScope is attached to the update object and a first middleware copies it to ctx.
 */

import { Bot, BotError } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import type { Context as HonoContext } from "hono";
import { onError, registerHandlers, type BotContext, type RequestScope } from "./handlers";
import { describeError } from "./notifier";

export const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const GETME_RETRY_MS = 60_000;
const MAX_UPDATE_BYTES = 1024 * 1024;

export interface BotEnv {
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  BOT_USERNAME?: string;
}

const scopes = new WeakMap<Update, RequestScope>();

/** Synthetic getMe result from a known username (avoids the network call entirely). */
export function botInfoFromUsername(token: string, username: string): UserFromGetMe {
  const id = Number(token.split(":", 1)[0]);
  const name = username.replace(/^@/, "");
  return {
    id: Number.isSafeInteger(id) ? id : 0,
    is_bot: true,
    first_name: name,
    username: name,
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
}

export function createBot(token: string, options: { botInfo?: UserFromGetMe } = {}): Bot<BotContext> {
  const bot = new Bot<BotContext>(token, {
    botInfo: options.botInfo,
    // Look up the global fetch on every call (lets tests stub it; nothing is captured at creation).
    client: { fetch: ((input, init) => fetch(input, init)) as typeof fetch },
  });
  bot.use((ctx, next) => {
    const scope = scopes.get(ctx.update);
    if (!scope) throw new Error("request scope is missing for update");
    ctx.scope = scope;
    return next();
  });
  registerHandlers(bot.errorBoundary(onError));
  return bot;
}

interface Instance {
  key: string;
  bot: Bot<BotContext>;
  me: Promise<UserFromGetMe> | null;
  meFailedAt: number;
}

let instance: Instance | null = null;

function getInstance(env: BotEnv): Instance {
  const key = `${env.BOT_TOKEN}\n${env.WEBHOOK_SECRET}\n${env.BOT_USERNAME ?? ""}`;
  if (instance?.key !== key) {
    const username = env.BOT_USERNAME?.trim();
    const bot = createBot(env.BOT_TOKEN, {
      botInfo: username ? botInfoFromUsername(env.BOT_TOKEN, username) : undefined,
    });
    instance = { key, bot, me: null, meFailedAt: 0 };
  }
  return instance;
}

/** The memoized bot for this isolate (created on first use). */
export function getBot(env: BotEnv): Bot<BotContext> {
  return getInstance(env).bot;
}

/** Bot info without repeated getMe calls: synthetic, already known, or one memoized getMe. */
export async function ensureBotInfo(env: BotEnv): Promise<UserFromGetMe> {
  const inst = getInstance(env);
  const bot = inst.bot;
  if (bot.isInited()) return bot.botInfo;
  if (!inst.me) {
    if (Date.now() - inst.meFailedAt < GETME_RETRY_MS) throw new Error("getMe failed recently");
    inst.me = bot.api.getMe();
    inst.me.then(
      (me) => {
        if (!bot.isInited()) bot.botInfo = me;
      },
      () => {
        inst.me = null;
        inst.meFailedAt = Date.now();
      },
    );
  }
  return inst.me;
}

/** Bot username for invite links: BOT_USERNAME, else the memoized getMe result; undefined on failure. */
export async function getBotUsername(env: BotEnv): Promise<string | undefined> {
  const fromEnv = env.BOT_USERNAME?.trim().replace(/^@/, "");
  if (fromEnv) return fromEnv;
  try {
    return (await ensureBotInfo(env)).username;
  } catch (err) {
    console.warn("bot username unavailable", { error: describeError(err, env.BOT_TOKEN) });
    return undefined;
  }
}

function isUpdate(value: unknown): value is Update {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Number.isSafeInteger((value as { update_id?: unknown }).update_id)
  );
}

/**
 * Process one webhook request. The caller must have verified the secret header already.
 * - bot info unavailable (getMe failed) → 503, Telegram redelivers later;
 * - malformed body → 400;
 * - otherwise 200 right away; the update is handled in `waitUntil` (or awaited when there is no ctx).
 *   Handler errors are answered to the user by the error boundary and logged here; never rethrown.
 */
export async function handleWebhook(
  c: HonoContext,
  env: BotEnv,
  scope: RequestScope,
  executionCtx: ExecutionContext | undefined,
): Promise<Response> {
  try {
    await ensureBotInfo(env);
  } catch (err) {
    console.error("bot info unavailable", { error: describeError(err, env.BOT_TOKEN) });
    return new Response(null, { status: 503 });
  }

  let update: unknown;
  try {
    const text = await c.req.text();
    if (text.length > MAX_UPDATE_BYTES) throw new Error("update is too large");
    update = JSON.parse(text);
  } catch (err) {
    console.warn("bad webhook body", { error: describeError(err) });
    return new Response(null, { status: 400 });
  }
  if (!isUpdate(update)) {
    console.warn("webhook body is not an update");
    return new Response(null, { status: 400 });
  }

  scopes.set(update, scope);
  const task = getBot(env)
    .handleUpdate(update)
    .catch((err: unknown) => {
      console.error("webhook update failed", {
        updateId: (update as Update).update_id,
        error: describeError(err instanceof BotError ? err.error : err, env.BOT_TOKEN),
      });
    });
  if (executionCtx) executionCtx.waitUntil(task);
  else await task;
  return new Response(null, { status: 200 });
}

export type { BotContext };
