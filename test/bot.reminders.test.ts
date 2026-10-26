import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { GrammyError } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as s from "../src/core/services";
import { MAX_REMINDERS_PER_RUN, parseRemindEveryDays, runReminders } from "../src/bot/reminders";
import type { DeliveryResult } from "../src/bot/notifier";
import worker from "../src/index";
import { mockTelegram, tgError } from "./bot.helpers";
import { A, ALICE, makeDeps } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Alice pays for an event with `debtors` other members; each debtor owes 100,00. */
async function eventWithDebtors(deps: s.Deps, title: string, firstId: number, debtors: number) {
  await s.upsertUser(deps, ALICE);
  const { event } = await s.createEvent(deps, A, title, "RUB");
  const ids: number[] = [];
  for (let i = 0; i < debtors; i++) {
    const id = firstId + i;
    await s.upsertUser(deps, { id, first_name: `U${id}` });
    await s.joinByInviteCode(deps, id, event.inviteCode);
    ids.push(id);
  }
  await s.addExpense(deps, event.id, A, {
    amount: 10000 * (debtors + 1),
    description: "Общее",
    payerId: A,
    participantIds: [A, ...ids],
  });
  return { event, ids };
}

async function remindedCount(): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM reminders").first<{ n: number }>())!.n;
}

describe("reminders", () => {
  it("parses REMIND_EVERY_DAYS defensively", () => {
    expect(parseRemindEveryDays("3")).toBe(3);
    expect(parseRemindEveryDays(" 7 ")).toBe(7);
    for (const bad of ["", "0", "-1", "1.5", "abc", undefined]) expect(parseRemindEveryDays(bad)).toBe(3);
  });

  it("sends via Telegram with text and button, then marks", async () => {
    const { deps } = makeDeps();
    const { event, ids } = await eventWithDebtors(deps, "Кафе & бар", 2001, 2);
    const tg = mockTelegram();
    const now = Date.now();
    const r = await runReminders(env, deps, now);
    expect(r).toMatchObject({ found: 2, sent: 2, unreachable: 0, failed: 0, rateLimited: false, marked: 2 });
    const sent = tg.sent();
    expect(sent.map((c) => c.payload.chat_id)).toEqual(ids);
    expect(sent[0]!.payload.text).toBe("Напоминание: вы должны 100 ₽ в «Кафе &amp; бар»");
    expect(sent[0]!.payload.reply_markup.inline_keyboard[0][0]).toEqual({
      text: "Открыть событие",
      web_app: { url: `${env.WEBAPP_URL}?event=${event.id}` },
    });
    // Not again within REMIND_EVERY_DAYS, again after it.
    expect((await runReminders(env, deps, now + DAY)).found).toBe(0);
    expect((await runReminders(env, deps, now + 3 * DAY)).sent).toBe(2);
  });

  it("processes at most one batch per run, the rest next run", async () => {
    const { deps } = makeDeps();
    await eventWithDebtors(deps, "Раз", 3001, 30);
    await eventWithDebtors(deps, "Два", 4001, 15);
    const batch = vi.spyOn(env.DB, "batch");
    const send = vi.fn(async (): Promise<DeliveryResult> => "sent");
    const now = Date.now();
    const r1 = await runReminders(env, deps, now, { send, limit: 1000 });
    expect(r1).toMatchObject({ found: MAX_REMINDERS_PER_RUN, sent: MAX_REMINDERS_PER_RUN, marked: MAX_REMINDERS_PER_RUN });
    expect(batch).toHaveBeenCalledTimes(1); // one markRemindedMany per run
    expect(await remindedCount()).toBe(MAX_REMINDERS_PER_RUN);
    const r2 = await runReminders(env, deps, now + 60_000, { send });
    expect(r2).toMatchObject({ found: 5, sent: 5, marked: 5 });
    expect(send).toHaveBeenCalledTimes(45);
  });

  it("marks unreachable users, does not mark network failures, stops on 429", async () => {
    const { deps } = makeDeps();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { ids } = await eventWithDebtors(deps, "Т", 5001, 4);
    const [blocked, flaky, ok, later] = ids as [number, number, number, number];
    const tg = mockTelegram((call) => {
      const id = call.payload.chat_id;
      if (id === blocked) return tgError(403, "Forbidden: bot was blocked by the user");
      if (id === flaky) throw new TypeError("network down");
      if (id === later) return tgError(429, "Too Many Requests: retry after 5", { parameters: { retry_after: 5 } });
      return undefined;
    });
    const now = Date.now();
    const started = Date.now();
    const r = await runReminders(env, deps, now);
    expect(Date.now() - started).toBeLessThan(3000); // no sleeping on 429
    expect(r).toMatchObject({ found: 4, sent: 1, unreachable: 1, failed: 1, rateLimited: true, marked: 2 });
    expect(tg.sent().length).toBe(4);
    const marked = await env.DB.prepare("SELECT user_id FROM reminders ORDER BY user_id").all<{ user_id: number }>();
    expect(marked.results.map((x) => x.user_id)).toEqual([blocked, ok]);

    // Next hour: only the network failure and the rate-limited one are retried.
    const tg2 = mockTelegram();
    const r2 = await runReminders(env, deps, now + 60 * 60 * 1000);
    expect(r2.sent).toBe(2);
    expect(tg2.sent().map((c) => c.payload.chat_id)).toEqual([flaky, later]);
  });

  it("marks rows Telegram definitely refused (4xx), retries 5xx and network errors", async () => {
    const { deps } = makeDeps();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { ids } = await eventWithDebtors(deps, "Т", 8001, 4);
    const [badHtml, forbidden, serverErr, net] = ids as [number, number, number, number];
    mockTelegram((call) => {
      const id = call.payload.chat_id;
      if (id === badHtml) return tgError(400, "Bad Request: can't parse entities");
      if (id === forbidden) return tgError(403, "Forbidden: some other reason");
      if (id === serverErr) return tgError(502, "Bad Gateway");
      if (id === net) throw new TypeError("network down");
      return undefined;
    });
    const now = Date.now();
    const r = await runReminders(env, deps, now);
    expect(r).toMatchObject({ found: 4, sent: 0, unreachable: 1, rejected: 1, failed: 2, marked: 2 });
    const marked = await env.DB.prepare("SELECT user_id FROM reminders ORDER BY user_id").all<{ user_id: number }>();
    expect(marked.results.map((x) => x.user_id)).toEqual([badHtml, forbidden]);

    const tg2 = mockTelegram();
    await runReminders(env, deps, now + 60 * 60 * 1000);
    expect(tg2.sent().map((c) => c.payload.chat_id)).toEqual([serverErr, net]);
  });

  it("a sender that throws a 429 GrammyError also stops the run without marking", async () => {
    const { deps } = makeDeps();
    vi.spyOn(console, "info").mockImplementation(() => {});
    await eventWithDebtors(deps, "Т", 9001, 3);
    const send = vi.fn(async (): Promise<DeliveryResult> => {
      throw new GrammyError("Too Many Requests", { ok: false, error_code: 429, description: "Too Many Requests" }, "sendMessage", {});
    });
    const r = await runReminders(env, deps, Date.now(), { send });
    expect(r).toMatchObject({ found: 3, rateLimited: true, marked: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await remindedCount()).toBe(0);
  });

  it("skips debtors with a pending settlement", async () => {
    const { deps } = makeDeps();
    const { event, ids } = await eventWithDebtors(deps, "Т", 6001, 2);
    await s.createSettlement(deps, event.id, ids[0]!, A, 5000);
    const send = vi.fn(async (): Promise<DeliveryResult> => "sent");
    const r = await runReminders(env, deps, Date.now(), { send });
    expect(r.found).toBe(1);
    expect(send.mock.calls.map((c: any[]) => c[0])).toEqual([ids[1]]);
  });

  it("the scheduled handler runs reminders", async () => {
    const { deps } = makeDeps();
    const { ids } = await eventWithDebtors(deps, "Крон", 7001, 1);
    const tg = mockTelegram();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "0 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(tg.sent().map((c) => c.payload.chat_id)).toEqual(ids);
    expect(await remindedCount()).toBe(1);
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
