/** Bot command handlers: /start, /start join_<code>, /help, /debts, fallback, error handler. */

import type { BotError, Composer, Context } from "grammy";
import { NotFoundError, ServiceError } from "../core/errors";
import { getUserDebtsSummary, joinByInviteCode, upsertUser, type Deps } from "../core/services";
import { openAppKeyboard, openEventKeyboard } from "./keyboards";
import { describeError } from "./notifier";
import {
  ERROR_TEXT,
  GREETING_TEXT,
  HELP_TEXT,
  INVITE_NOT_FOUND_TEXT,
  UNKNOWN_TEXT,
  formatDebtsSummary,
  joinFailedText,
  joinedText,
  parseJoinPayload,
  splitMessage,
} from "./texts";

/** Per-request dependencies, attached to every update before the handlers run. */
export interface RequestScope {
  deps: Deps;
  webappUrl: string;
}

export type BotContext = Context & { scope: RequestScope };

const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

export async function onError(err: BotError<BotContext>): Promise<void> {
  const ctx = err.ctx;
  console.error("bot handler failed", {
    updateId: ctx.update.update_id,
    error: describeError(err.error, ctx.api.token),
  });
  if (!ctx.chat) return;
  try {
    await ctx.reply(ERROR_TEXT);
  } catch (sendErr) {
    console.warn("could not send error message", { error: describeError(sendErr, ctx.api.token) });
  }
}

/** Register all handlers on `composer` (normally the bot's error boundary). */
export function registerHandlers(composer: Composer<BotContext>): void {
  // Mini App (web_app) buttons work only in private chats; everything else is ignored.
  const pm = composer.chatType("private");

  // Every message upserts its author.
  pm.use(async (ctx, next) => {
    if (ctx.from && !ctx.from.is_bot) await upsertUser(ctx.scope.deps, ctx.from);
    await next();
  });

  pm.command("start", async (ctx) => {
    const { deps, webappUrl } = ctx.scope;
    const payload = parseJoinPayload(ctx.match);
    if (payload === null) {
      await ctx.reply(GREETING_TEXT, { ...HTML, reply_markup: openAppKeyboard(webappUrl) });
      return;
    }
    let result;
    try {
      result = await joinByInviteCode(deps, ctx.from.id, payload);
    } catch (err) {
      if (!(err instanceof ServiceError)) throw err;
      console.info("join failed", { userId: ctx.from.id, reason: err.message });
      const text = err instanceof NotFoundError ? INVITE_NOT_FOUND_TEXT : joinFailedText(err.message);
      await ctx.reply(text, { ...HTML, reply_markup: openAppKeyboard(webappUrl) });
      return;
    }
    await ctx.reply(joinedText(result.event.title, result.joinedNow), {
      ...HTML,
      reply_markup: openEventKeyboard(webappUrl, result.event.id),
    });
  });

  pm.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT, { ...HTML, reply_markup: openAppKeyboard(ctx.scope.webappUrl) });
  });

  pm.command("debts", async (ctx) => {
    const items = await getUserDebtsSummary(ctx.scope.deps, ctx.from.id);
    const chunks = splitMessage(formatDebtsSummary(items));
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      await ctx.reply(chunks[i]!, { ...HTML, reply_markup: last ? openAppKeyboard(ctx.scope.webappUrl) : undefined });
    }
  });

  // Any other message: a hint with the commands.
  pm.on("message", async (ctx) => {
    await ctx.reply(UNKNOWN_TEXT, { ...HTML, reply_markup: openAppKeyboard(ctx.scope.webappUrl) });
  });
}
