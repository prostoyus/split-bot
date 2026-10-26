/**
 * Notification contract between core services and the bot layer.
 * Core never imports Telegram code: the bot provides a Notifier implementation.
 */

export interface NotifyExtra {
  /** Event to open from the "Открыть событие" button. */
  eventId?: number;
}

/**
 * Fire-and-forget: must return immediately (schedule delivery with ctx.waitUntil) and never throw.
 * `html` is Telegram HTML (parse_mode "HTML"); user-supplied values in it are already escaped.
 */
export type Notifier = (userId: number, html: string, extra?: NotifyExtra) => void;

/** Async delivery function, e.g. a Telegram sendMessage wrapper. */
export type NotificationSender = (userId: number, html: string, extra?: NotifyExtra) => Promise<unknown>;

export const noopNotifier: Notifier = () => {};

/**
 * Build a Notifier that schedules `send` with `waitUntil` (pass `ctx.waitUntil.bind(ctx)`),
 * swallowing and logging every delivery error. Never retries.
 */
export function createNotifier(
  waitUntil: (promise: Promise<unknown>) => void,
  send: NotificationSender,
): Notifier {
  return (userId, html, extra) => {
    let promise: Promise<unknown>;
    try {
      promise = Promise.resolve(send(userId, html, extra));
    } catch (err) {
      promise = Promise.reject(err);
    }
    waitUntil(
      promise.catch((err: unknown) => {
        console.warn("notify failed", { userId, error: err instanceof Error ? err.message : String(err) });
      }),
    );
  };
}

/** Call a notifier without letting a buggy implementation break the caller. */
export function safeNotify(notify: Notifier, userId: number, html: string, extra?: NotifyExtra): void {
  try {
    notify(userId, html, extra);
  } catch (err) {
    console.warn("notifier threw", { userId, error: err instanceof Error ? err.message : String(err) });
  }
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};

/** Escape text for Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}
