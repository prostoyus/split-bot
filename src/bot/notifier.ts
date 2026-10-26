/** Telegram implementation of the core NotificationSender (sendMessage with an "Открыть событие" button). */

import { GrammyError, HttpError, type Api } from "grammy";
import type { NotifyExtra } from "../core/notify";
import { openEventKeyboard } from "./keyboards";

/**
 * - "sent": delivered;
 * - "unreachable": the user blocked the bot / never started it (403) or the chat does not exist (400);
 * - "rate_limited": Telegram answered 429. We never sleep on Workers (CPU/time budget), just report it.
 * Any other failure (network, 5xx, unexpected 400) is thrown.
 */
export type DeliveryResult = "sent" | "unreachable" | "rate_limited";

export type TelegramSender = (userId: number, html: string, extra?: NotifyExtra) => Promise<DeliveryResult>;

const UNREACHABLE_400 = /chat not found|user not found|peer_id_invalid|bot can't initiate|user is deactivated/i;

/** Short error description for logs; never contains the bot token. */
export function describeError(err: unknown, token?: string): string {
  let text: string;
  if (err instanceof GrammyError) text = `GrammyError ${err.error_code}: ${err.description}`;
  else if (err instanceof HttpError) text = `HttpError: ${err.message}`;
  else if (err instanceof Error) text = `${err.name}: ${err.message}`;
  else text = String(err);
  return token ? text.split(token).join("***") : text;
}

export function createTelegramSender(api: Api, webappUrl: string): TelegramSender {
  return async (userId, html, extra) => {
    const eventId = extra?.eventId;
    try {
      await api.sendMessage(userId, html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: eventId !== undefined && eventId !== null ? openEventKeyboard(webappUrl, eventId) : undefined,
      });
      return "sent";
    } catch (err) {
      if (err instanceof GrammyError) {
        if (err.error_code === 403 || (err.error_code === 400 && UNREACHABLE_400.test(err.description))) {
          console.info("telegram user unreachable", { userId, code: err.error_code });
          return "unreachable";
        }
        if (err.error_code === 429) {
          console.warn("telegram rate limit hit", { userId, retryAfter: err.parameters?.retry_after });
          return "rate_limited";
        }
      }
      throw err;
    }
  };
}
