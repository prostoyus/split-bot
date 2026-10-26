/** Mini App URL builder and inline keyboards. */

import { InlineKeyboard } from "grammy";
import { OPEN_APP_TEXT, OPEN_EVENT_TEXT } from "./texts";

/**
 * Return `WEBAPP_URL[?|&]event=<id>`; without an event id WEBAPP_URL is returned as is.
 * Existing query parameters are kept and a `#fragment` stays at the end (like v1).
 */
export function buildWebappUrl(webappUrl: string, eventId?: number | null): string {
  const base = (webappUrl ?? "").trim();
  if (!base) throw new Error("WEBAPP_URL is empty");
  if (eventId === undefined || eventId === null) return base;
  if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new Error("invalid event id");
  const hashAt = base.indexOf("#");
  const head = hashAt >= 0 ? base.slice(0, hashAt) : base;
  const hash = hashAt >= 0 ? base.slice(hashAt) : "";
  let sep = "?";
  if (head.includes("?")) sep = head.endsWith("?") || head.endsWith("&") ? "" : "&";
  return `${head}${sep}event=${eventId}${hash}`;
}

export function openAppKeyboard(webappUrl: string): InlineKeyboard {
  return new InlineKeyboard().webApp(OPEN_APP_TEXT, buildWebappUrl(webappUrl));
}

/** "Открыть событие" button for an event, or the plain "Открыть" button without one. */
export function openEventKeyboard(webappUrl: string, eventId?: number | null): InlineKeyboard {
  const hasEvent = eventId !== undefined && eventId !== null;
  return new InlineKeyboard().webApp(hasEvent ? OPEN_EVENT_TEXT : OPEN_APP_TEXT, buildWebappUrl(webappUrl, eventId));
}
