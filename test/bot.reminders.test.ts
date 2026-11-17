import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { GrammyError } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as s from "../src/core/services";
import { MAX_REMINDERS_PER_RUN, parseRemindEveryDays, runReminders, type ReminderSender } from "../src/bot/reminders";
import { formatUserReminder } from "../src/bot/texts";
import worker from "../src/index";
import { mockTelegram, tgError } from "./bot.helpers";
import { A, ALICE, makeDeps } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.restoreAllMocks();
});

function quiet() {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
}

/** Alice pays for an event with `debtors` other members; each debtor owes `share` (minor units). */
async function eventWithDebtors(
  deps: s.Deps,
  title: string,
  firstId: number,
  debtors: number,
  opts: { currency?: string; share?: number } = {},
) {
  const share = opts.share ?? 10000;
  await s.upsertUser(deps, ALICE);
  const { event } = await s.createEvent(deps, A, title, opts.currency ?? "RUB");
  const ids: number[] = [];
  for (let i = 0; i < debtors; i++) {
    const id = firstId + i;
    await s.upsertUser(deps, { id, first_name: `U${id}` });
    await s.joinByInviteCode(deps, id, event.inviteCode);
    ids.push(id);
  }
  await s.addExpense(deps, event.id, A, {
    amount: share * (debtors + 1),
    description: "Общее",
    payerId: A,
    participantIds: [A, ...ids],
  });
  return { event, ids };
}

async function markedUsers(): Promise<number[]> {
  const r = await env.DB.prepare("SELECT user_id FROM user_reminders ORDER BY user_id").all<{ user_id: number }>();
  return r.results.map((x) => x.user_id);
}

describe("formatUserReminder", () => {
  it("single currency", () => {
    expect(
      formatUserReminder({
        owe: [{ currency: "RUB", amount: 300000 }],
        events: [
          { eventId: 1, title: "Сочи", currency: "RUB", amount: 200000 },
          { eventId: 2, title: "Квартира", currency: "RUB", amount: 100000 },
        ],
      }),
    ).toBe(
      [
        "🔔 <b>Напоминание о долгах</b>",
        "Всего вы должны: 3 000 ₽",
        "Из них:",
        "«Сочи» — 2 000 ₽",
        "«Квартира» — 1 000 ₽",
        "",
        "Подробности и кнопка «Я вернул» — в приложении.",
      ].join("\n"),
    );
  });

  it("several currencies are joined with «и», titles are escaped", () => {
    const text = formatUserReminder({
      owe: [
        { currency: "RUB", amount: 300000 },
        { currency: "USD", amount: 2000 },
      ],
      events: [
        { eventId: 1, title: "<b>Сочи</b> & co", currency: "RUB", amount: 300000 },
        { eventId: 2, title: "NY", currency: "USD", amount: 2000 },
      ],
    });
    expect(text).toContain("Всего вы должны: 3 000 ₽ и 20 $\nИз них:");
    expect(text).toContain("«&lt;b&gt;Сочи&lt;/b&gt; &amp; co» — 3 000 ₽");
    expect(text).toContain("«NY» — 20 $");
    expect(text).not.toContain("<b>Сочи");
  });

  it("truncates a long event list with «…и ещё N» and stays under 4096", () => {
    const events = Array.from({ length: 200 }, (_, i) => ({
      eventId: i + 1,
      title: "Очень длинное название события ".repeat(2).slice(0, 60) + i,
      currency: "RUB",
      amount: 100000 - i,
    }));
    const text = formatUserReminder({ owe: [{ currency: "RUB", amount: 1 }], events });
    expect(text.length).toBeLessThan(4096);
    const more = /…и ещё (\d+)\n\nПодробности/.exec(text);
    expect(more).not.toBeNull();
    const shown = text.split("\n").filter((l) => l.startsWith("«")).length;
    expect(shown + Number(more![1])).toBe(200);
    expect(text.endsWith("Подробности и кнопка «Я вернул» — в приложении.")).toBe(true);

    // Exact fit boundaries for a small limit.
    const small = { owe: [{ currency: "RUB", amount: 1 }], events: events.slice(0, 5) };
    for (let limit = 150; limit < 600; limit += 7) {
      const t = formatUserReminder(small, limit);
      expect(t.length).toBeLessThanOrEqual(limit);
    }
    // No truncation line when everything fits.
    expect(formatUserReminder(small)).not.toContain("…и ещё");
  });

  it("shows both sides when other events offset the debt", () => {
    expect(
      formatUserReminder({
        owe: [{ currency: "RUB", amount: 5400 }],
        events: [{ eventId: 1, title: "Аптека", currency: "RUB", amount: 123000 }],
        owedEvents: [{ eventId: 2, title: "Продукты", currency: "RUB", amount: 117600 }],
      }),
    ).toBe(
      [
        "🔔 <b>Напоминание о долгах</b>",
        "Всего вы должны: 54 ₽",
        "Вы должны:",
        "«Аптека» — 1 230 ₽",
        "Вам должны:",
        "«Продукты» — 1 176 ₽",
        "",
        "Подробности и кнопка «Я вернул» — в приложении.",
      ].join("\n"),
    );
  });

  it("truncation counts both sides and stays within the limit", () => {
    const many = (n: number, base: number) =>
      Array.from({ length: n }, (_, i) => ({ eventId: base + i, title: `Событие ${base + i}`, currency: "RUB", amount: 100 }));
    const text = formatUserReminder({ owe: [{ currency: "RUB", amount: 1 }], events: many(150, 1), owedEvents: many(150, 1000) });
    expect(text.length).toBeLessThan(4096);
    const more = /…и ещё (\d+)\n\nПодробности/.exec(text);
    expect(more).not.toBeNull();
    const listed = text.split("\n").filter((l) => l.startsWith("«")).length;
    expect(listed + Number(more![1])).toBe(300);
  });
});

describe("runReminders (weekly, by totals)", () => {
  it("parses REMIND_EVERY_DAYS defensively (default 7)", () => {
    expect(parseRemindEveryDays("3")).toBe(3);
    expect(parseRemindEveryDays(" 7 ")).toBe(7);
    for (const bad of ["", "0", "-1", "1.5", "abc", undefined]) expect(parseRemindEveryDays(bad)).toBe(7);
  });

  it("one message per user across events, «Открыть» button without event, then marks", async () => {
    const { deps } = makeDeps();
    quiet();
    const { ids } = await eventWithDebtors(deps, "Сочи", 2001, 1, { share: 200000 });
    const debtor = ids[0]!;
    const { event: e2 } = await s.createEvent(deps, A, "Квартира & Co", "RUB");
    await s.joinByInviteCode(deps, debtor, e2.inviteCode);
    await s.addExpense(deps, e2.id, A, { amount: 200000, description: "Аренда", payerId: A, participantIds: [A, debtor] });

    const tg = mockTelegram();
    const now = Date.now();
    const r = await runReminders(env, deps, now);
    expect(r).toMatchObject({ found: 1, sent: 1, marked: 1, rateLimited: false });
    const [msg] = tg.sent();
    expect(msg!.payload.chat_id).toBe(debtor);
    expect(msg!.payload.parse_mode).toBe("HTML");
    expect(msg!.payload.text).toBe(
      [
        "🔔 <b>Напоминание о долгах</b>",
        "Всего вы должны: 3 000 ₽",
        "Из них:",
        "«Сочи» — 2 000 ₽",
        "«Квартира &amp; Co» — 1 000 ₽",
        "",
        "Подробности и кнопка «Я вернул» — в приложении.",
      ].join("\n"),
    );
    expect(msg!.payload.reply_markup.inline_keyboard).toEqual([[{ text: "Открыть", web_app: { url: env.WEBAPP_URL } }]]);
    expect(await markedUsers()).toEqual([debtor]);

    // Not again within REMIND_EVERY_DAYS (7), again after it.
    expect((await runReminders(env, deps, now + 3 * DAY)).found).toBe(0);
    expect((await runReminders(env, deps, now + 7 * DAY)).sent).toBe(1);
  });

  it("processes at most one batch per run, the rest next run, one mark batch per run", async () => {
    const { deps } = makeDeps();
    quiet();
    await eventWithDebtors(deps, "Раз", 3001, 30);
    await eventWithDebtors(deps, "Два", 4001, 15);
    const batch = vi.spyOn(env.DB, "batch");
    const send = vi.fn<ReminderSender>(async () => "sent");
    const now = Date.now();
    const r1 = await runReminders(env, deps, now, { send, limit: 1000 });
    expect(r1).toMatchObject({ found: MAX_REMINDERS_PER_RUN, sent: MAX_REMINDERS_PER_RUN, marked: MAX_REMINDERS_PER_RUN });
    expect(batch).toHaveBeenCalledTimes(1);
    expect((await markedUsers()).length).toBe(MAX_REMINDERS_PER_RUN);
    const r2 = await runReminders(env, deps, now + 60_000, { send });
    expect(r2).toMatchObject({ found: 5, sent: 5, marked: 5 });
    expect(new Set(send.mock.calls.map((c) => c[0])).size).toBe(45);
  });

  it("marks sent + any 4xx except 429; not network / 5xx", async () => {
    const { deps } = makeDeps();
    quiet();
    const { ids } = await eventWithDebtors(deps, "Т", 5001, 6);
    const [ok, blocked, notFound, badHtml, serverErr, net] = ids as [number, number, number, number, number, number];
    mockTelegram((call) => {
      switch (call.payload.chat_id) {
        case blocked:
          return tgError(403, "Forbidden: bot was blocked by the user");
        case notFound:
          return tgError(400, "Bad Request: chat not found");
        case badHtml:
          return tgError(400, "Bad Request: can't parse entities");
        case serverErr:
          return tgError(502, "Bad Gateway");
        case net:
          throw new TypeError("network down");
        default:
          return undefined;
      }
    });
    const now = Date.now();
    const r = await runReminders(env, deps, now);
    expect(r).toMatchObject({ found: 6, sent: 1, unreachable: 2, rejected: 1, failed: 2, rateLimited: false, marked: 4 });
    expect(await markedUsers()).toEqual([ok, blocked, notFound, badHtml]);

    // Next hour only the 5xx / network users are retried.
    const tg2 = mockTelegram();
    await runReminders(env, deps, now + 60 * 60 * 1000);
    expect(tg2.sent().map((c) => c.payload.chat_id)).toEqual([serverErr, net]);
  });

  it("429 stops the run, the rest are not marked and go first next time", async () => {
    const { deps } = makeDeps();
    quiet();
    const { ids } = await eventWithDebtors(deps, "Т", 6001, 4);
    const [first, limited] = ids as [number, number, number, number];
    const tg = mockTelegram((call) =>
      call.payload.chat_id === limited
        ? tgError(429, "Too Many Requests: retry after 30", { parameters: { retry_after: 30 } })
        : undefined,
    );
    const now = Date.now();
    const started = Date.now();
    const r = await runReminders(env, deps, now);
    expect(Date.now() - started).toBeLessThan(3000); // never sleeps
    expect(r).toMatchObject({ found: 4, sent: 1, rateLimited: true, marked: 1 });
    expect(tg.sent().map((c) => c.payload.chat_id)).toEqual([first, limited]);
    expect(await markedUsers()).toEqual([first]);

    const tg2 = mockTelegram();
    await runReminders(env, deps, now + 60_000);
    expect(tg2.sent().map((c) => c.payload.chat_id)).toEqual(ids.slice(1));
  });

  it("a sender throwing a 429 GrammyError also stops without marking", async () => {
    const { deps } = makeDeps();
    quiet();
    await eventWithDebtors(deps, "Т", 9001, 3);
    const send = vi.fn<ReminderSender>(async () => {
      throw new GrammyError("Too Many Requests", { ok: false, error_code: 429, description: "Too Many Requests" }, "sendMessage", {});
    });
    const r = await runReminders(env, deps, Date.now(), { send });
    expect(r).toMatchObject({ found: 3, rateLimited: true, marked: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await markedUsers()).toEqual([]);
  });

  it("a pending return counts as paid", async () => {
    const { deps } = makeDeps();
    quiet();
    const { event, ids } = await eventWithDebtors(deps, "Т", 7001, 2);
    await s.createSettlement(deps, event.id, ids[0]!, A, 10000);
    const send = vi.fn<ReminderSender>(async () => "sent");
    const r = await runReminders(env, deps, Date.now(), { send });
    expect(r.found).toBe(1);
    expect(send.mock.calls.map((c) => c[0])).toEqual([ids[1]]);
  });

  it("the scheduled handler runs reminders", async () => {
    const { deps } = makeDeps();
    quiet();
    const { ids } = await eventWithDebtors(deps, "Крон", 8001, 1);
    const tg = mockTelegram();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "0 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(tg.sent().map((c) => c.payload.chat_id)).toEqual(ids);
    expect(await markedUsers()).toEqual(ids);
  });

  it("the scheduled handler never throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("D1 is down");
    });
    const ctx = createExecutionContext();
    await expect(
      worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "0 * * * *" }), env, ctx),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});
