/**
 * Weekly debt reminders by totals across events, one message per user (cron, hourly).
 * SPEC "Weekly reminders (by totals)".
 *
 * Cloudflare Free plan: 50 external subrequests per invocation (D1 counts as an internal service,
 * 1000/invocation). Each reminder is one Telegram sendMessage, so a run handles at most
 * MAX_REMINDERS_PER_RUN users; the rest are picked up next hour. Sends are sequential to stay
 * well under Telegram's rate limits; the whole run is one D1 read + one markUsersReminded batch.
 */

import { GrammyError } from "grammy";
import { findUsersToRemind, markUsersReminded, type Deps } from "../core/services";
import type { Env } from "../env";
import { getBot } from "./bot";
import { openAppKeyboard } from "./keyboards";
import { describeError, isUnreachable } from "./notifier";
import { formatUserReminder } from "./texts";

export const MAX_REMINDERS_PER_RUN = 40;
export const DEFAULT_REMIND_EVERY_DAYS = 7;

/** "sent" | "unreachable" | "rate_limited"; throws GrammyError for other API errors, anything else for network. */
export type ReminderSender = (userId: number, html: string) => Promise<"sent" | "unreachable" | "rate_limited">;

export interface ReminderRunResult {
  found: number;
  sent: number;
  /** Blocked the bot / chat not found: marked. */
  unreachable: number;
  /** Telegram refused the message (any other 4xx except 429): marked, not retried every hour. */
  rejected: number;
  /** Network errors, Telegram 5xx, unexpected errors: not marked, retried next hour. */
  failed: number;
  rateLimited: boolean;
  marked: number;
}

export function parseRemindEveryDays(raw: string | undefined): number {
  const n = Number((raw ?? "").trim());
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : DEFAULT_REMIND_EVERY_DAYS;
}

/** Telegram sender for reminders: HTML + the "Открыть" web_app button (no event param). */
export function createReminderSender(env: Env): ReminderSender {
  const api = getBot(env).api;
  const reply_markup = openAppKeyboard(env.WEBAPP_URL);
  return async (userId, html) => {
    try {
      await api.sendMessage(userId, html, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup });
      return "sent";
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 429) return "rate_limited";
      if (isUnreachable(err)) return "unreachable";
      throw err;
    }
  };
}

export async function runReminders(
  env: Env,
  deps: Deps,
  now: Date | number = Date.now(),
  options: { limit?: number; send?: ReminderSender } = {},
): Promise<ReminderRunResult> {
  const limit = Math.min(options.limit ?? MAX_REMINDERS_PER_RUN, MAX_REMINDERS_PER_RUN);
  const due = await findUsersToRemind(deps, now, parseRemindEveryDays(env.REMIND_EVERY_DAYS), limit);
  const result: ReminderRunResult = {
    found: due.length,
    sent: 0,
    unreachable: 0,
    rejected: 0,
    failed: 0,
    rateLimited: false,
    marked: 0,
  };
  if (due.length === 0) return result;

  const send = options.send ?? createReminderSender(env);
  const done: number[] = [];
  for (const r of due) {
    const log = { userId: r.userId };
    try {
      const status = await send(r.userId, formatUserReminder(r));
      if (status === "rate_limited") {
        // Never sleep on Workers: stop here, this user and the rest go next hour.
        result.rateLimited = true;
        console.warn("reminders: telegram rate limit, stopping run", log);
        break;
      }
      if (status === "sent") result.sent++;
      else result.unreachable++;
      done.push(r.userId);
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 429) {
        result.rateLimited = true;
        console.warn("reminders: telegram rate limit, stopping run", log);
        break;
      }
      if (err instanceof GrammyError && err.error_code >= 400 && err.error_code < 500) {
        // A definite refusal: retrying every hour would not help, mark like an unreachable user.
        result.rejected++;
        done.push(r.userId);
        console.warn("reminder rejected by telegram", { ...log, error: describeError(err, env.BOT_TOKEN) });
        continue;
      }
      result.failed++;
      console.warn("reminder failed", { ...log, error: describeError(err, env.BOT_TOKEN) });
    }
  }
  if (done.length > 0) await markUsersReminded(deps, done, now);
  result.marked = done.length;
  console.info("reminders run", result);
  return result;
}
