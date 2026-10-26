/** User-facing bot texts (Russian, ported from v1 bot/handlers.py) and pure text helpers. */

import { CURRENCIES } from "../core/money";
import { escapeHtml } from "../core/notify";
import { formatMoney, type DebtReminder, type UserEventDebts } from "../core/services";

export const MAX_MESSAGE_LEN = 4096;
export const JOIN_PREFIX = "join_";

export const OPEN_APP_TEXT = "Открыть";
export const OPEN_EVENT_TEXT = "Открыть событие";

export const GREETING_TEXT =
  "Привет! Я бот <b>«Кто кому должен»</b>.\n\n" +
  "Помогаю делить общие траты — в поездке, на вечеринке, в съёмной квартире:\n" +
  "• создайте событие и пригласите друзей по ссылке;\n" +
  "• записывайте, кто за что заплатил;\n" +
  "• я посчитаю, кто кому сколько должен, с минимумом переводов;\n" +
  "• отмечайте возвраты, а я напомню должникам.\n\n" +
  "Нажмите «Открыть», чтобы начать.";

export const HELP_TEXT =
  "<b>Как пользоваться</b>\n\n" +
  "1. Нажмите «Открыть» (или кнопку меню слева от поля ввода).\n" +
  "2. Создайте событие, например «Поездка в Казань».\n" +
  "3. На вкладке «Участники» нажмите «Пригласить» и отправьте ссылку друзьям.\n" +
  "4. Добавляйте траты: сумму, описание, кто платил и на кого делить.\n" +
  "5. На вкладке «Балансы» видно, кто кому должен. Вернули деньги — нажмите «Я вернул», " +
  "получатель подтвердит.\n\n" +
  "<b>Команды</b>\n" +
  "/start — открыть приложение\n" +
  "/debts — мои долги по всем событиям\n" +
  "/help — эта справка";

export const NO_DEBTS_TEXT = "Долгов нет 🎉";
export const INVITE_NOT_FOUND_TEXT =
  "Не получилось присоединиться: приглашение не найдено. Попросите у друзей свежую ссылку.";
export const ERROR_TEXT = "Что-то пошло не так. Попробуйте ещё раз чуть позже.";
export const UNKNOWN_TEXT = "Я понимаю команды /start, /debts и /help. Всё остальное — в приложении:";

/** Commands shown in the Telegram menu (set by /admin/setup). */
export const BOT_COMMANDS = [
  { command: "start", description: "Открыть приложение" },
  { command: "debts", description: "Мои долги" },
  { command: "help", description: "Как пользоваться" },
] as const;

export function joinFailedText(message: string): string {
  return `Не получилось присоединиться: ${escapeHtml(message)}`;
}

export function joinedText(title: string, joinedNow: boolean): string {
  const t = escapeHtml(title);
  return joinedNow ? `Вы в событии «${t}»` : `Вы уже в событии «${t}»`;
}

export function reminderText(r: Pick<DebtReminder, "amount" | "currency" | "eventTitle">): string {
  return `Напоминание: вы должны ${formatMoney(r.amount, r.currency)} в «${escapeHtml(r.eventTitle)}»`;
}

/** Return the trimmed payload if /start args look like `join_<code>`, else null. */
export function parseJoinPayload(args: string | null | undefined): string | null {
  const a = (args ?? "").trim();
  return a.startsWith(JOIN_PREFIX) ? a : null;
}

/**
 * "Итого" block (SPEC "Totals across events"): per currency, never converted.
 * owe = sum of |net| for net < 0, owed = sum of net for net > 0, total = owed - owe.
 * Zero owe/owed lines are omitted; currencies are labelled only when there are several.
 * Returns null when every net is zero.
 */
export function formatTotals(items: readonly Pick<UserEventDebts, "currency" | "net">[]): string | null {
  const totals = new Map<string, { owe: number; owed: number }>();
  for (const item of items) {
    if (!item.net) continue;
    let t = totals.get(item.currency);
    if (!t) totals.set(item.currency, (t = { owe: 0, owed: 0 }));
    if (item.net < 0) t.owe += -item.net;
    else t.owed += item.net;
  }
  if (totals.size === 0) return null;
  const lines = ["<b>Итого</b>"];
  const labelled = totals.size > 1;
  // Same currency order as the Mini App totals card: the CURRENCIES list, unknown codes last.
  const rank = (c: string) => {
    const i = (CURRENCIES as readonly string[]).indexOf(c);
    return i === -1 ? CURRENCIES.length : i;
  };
  const ordered = [...totals].sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : 1));
  for (const [currency, { owe, owed }] of ordered) {
    if (labelled) lines.push(`<i>${escapeHtml(currency)}</i>`);
    if (owe > 0) lines.push(`Вы должны: ${formatMoney(owe, currency)}`);
    if (owed > 0) lines.push(`Вам должны: ${formatMoney(owed, currency)}`);
    const total = owed - owe;
    if (total > 0) lines.push(`В итоге: вам должны ${formatMoney(total, currency)}`);
    else if (total < 0) lines.push(`В итоге: вы должны ${formatMoney(-total, currency)}`);
    else lines.push("Всё ровно");
  }
  return lines.join("\n");
}

/** Human readable (HTML) summary of the user's debts across events: totals first, then per event. */
export function formatDebtsSummary(items: readonly UserEventDebts[]): string {
  const totals = formatTotals(items);
  if (totals === null) return NO_DEBTS_TEXT;
  const blocks = [totals, "<b>Ваши долги</b>"];
  for (const item of items) {
    const lines = [`<b>«${escapeHtml(item.title)}»</b>`];
    for (const t of item.owes) {
      lines.push(`Вы должны: ${escapeHtml(t.toUser.name)} — ${formatMoney(t.amount, item.currency)}`);
    }
    for (const t of item.owedBy) {
      lines.push(`Вам должен(-а): ${escapeHtml(t.fromUser.name)} — ${formatMoney(t.amount, item.currency)}`);
    }
    if (item.owes.length === 0 && item.owedBy.length === 0) {
      lines.push(`Ваш баланс: ${formatMoney(item.net, item.currency)}`);
    }
    blocks.push(lines.join("\n"));
  }
  blocks.push("Подробности и кнопка «Я вернул» — в приложении.");
  return blocks.join("\n\n");
}

/** Split text into chunks <= limit, preferring line boundaries (lines carry balanced HTML tags). */
export function splitMessage(text: string, limit: number = MAX_MESSAGE_LEN): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  for (let line of text.split("\n")) {
    while (line.length > limit) {
      // A single very long line: hard cut.
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(line.slice(0, limit));
      line = line.slice(limit);
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
