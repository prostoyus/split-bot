/**
 * Hourly debt reminders (cron). SPEC "Bot / Reminders".
 *
 * Cloudflare Free plan: 50 external subrequests per invocation (D1 counts as an internal service,
 * 1000/invocation). Each reminder is one Telegram sendMessage, so a run sends at most
 * MAX_REMINDERS_PER_RUN messages; the rest are picked up next hour. Sends are sequential to stay
 * well under Telegram's rate limits, and the whole run uses one D1 query + one D1 batch.
 */

import { GrammyError } from "grammy";
import { findDebtorsToRemind, markRemindedMany, type Deps } from "../core/services";
import type { Env } from "../env";
import { getBot } from "./bot";
import { createTelegramSender, describeError, type TelegramSender } from "./notifier";
import { reminderText } from "./texts";

export const MAX_REMINDERS_PER_RUN = 40;
export const DEFAULT_REMIND_EVERY_DAYS = 3;

export interface ReminderRunResult {
  found: number;
  sent: number;
  unreachable: number;
  /** Telegram refused the message (any 4xx except 429): marked, not retried every hour. */
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

export async function runReminders(
  env: Env,
  deps: Deps,
  now: Date | number = Date.now(),
  options: { limit?: number; send?: TelegramSender } = {},
): Promise<ReminderRunResult> {
  const limit = Math.min(options.limit ?? MAX_REMINDERS_PER_RUN, MAX_REMINDERS_PER_RUN);
  const due = await findDebtorsToRemind(deps, now, parseRemindEveryDays(env.REMIND_EVERY_DAYS), limit);
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

  const send = options.send ?? createTelegramSender(getBot(env).api, env.WEBAPP_URL);
  const done: { eventId: number; userId: number }[] = [];
  for (const r of due) {
    try {
      const status = await send(r.userId, reminderText(r), { eventId: r.eventId });
      if (status === "rate_limited") {
        // Do not wait on Workers: stop here, the rest (and this one) go next hour.
        result.rateLimited = true;
        break;
      }
      if (status === "sent") result.sent++;
      else result.unreachable++;
      // Unreachable users are marked too, so they are retried only after the throttle period.
      done.push({ eventId: r.eventId, userId: r.userId });
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 429) {
        result.rateLimited = true;
        break;
      }
      if (err instanceof GrammyError && err.error_code < 500) {
        // A definite answer from Telegram (e.g. 400 can't parse, 403 other reason): retrying every
        // hour would not help, so mark it like an unreachable user.
        result.rejected++;
        done.push({ eventId: r.eventId, userId: r.userId });
        console.warn("reminder rejected by telegram", { userId: r.userId, eventId: r.eventId, error: describeError(err, env.BOT_TOKEN) });
        continue;
      }
      // Network errors, Telegram 5xx (transient), unexpected errors: not marked, retried next hour.
      result.failed++;
      console.warn("reminder failed", { userId: r.userId, eventId: r.eventId, error: describeError(err, env.BOT_TOKEN) });
    }
  }
  await markRemindedMany(deps, done, now);
  result.marked = done.length;
  console.info("reminders run", result);
  return result;
}
