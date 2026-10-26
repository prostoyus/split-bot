import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BadRequestError, ForbiddenError, NotFoundError, ServiceError } from "../src/core/errors";
import * as s from "../src/core/services";
import { A, ALICE, B, C, M, eventWithThree, makeDeps, seedUsers } from "./helpers";

async function errorOf(p: Promise<unknown>): Promise<ServiceError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ServiceError);
  return err as ServiceError;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function expectError(p: Promise<unknown>, cls: abstract new (...args: any[]) => ServiceError, message?: string) {
  const err = await errorOf(p);
  expect(err).toBeInstanceOf(cls);
  if (message !== undefined) expect(err.message).toBe(message);
}

const netsObj = async (deps: s.Deps, eventId: number) => Object.fromEntries(await s.computeNets(deps, eventId));
const equal = (amount: number, payerId: number, participantIds: number[], description = "x") => ({
  amount,
  description,
  payerId,
  participantIds,
});

describe("users and events", () => {
  it("upsert updates fields", async () => {
    const { deps } = makeDeps();
    await s.upsertUser(deps, { id: 1, first_name: "Old" });
    const user = await s.upsertUser(deps, { id: 1, first_name: "New", last_name: "Name", username: "nick" });
    expect(user).toEqual({ id: 1, name: "New Name", username: "nick" });
    expect(await s.getUser(deps, 1)).toEqual(user);
    await s.upsertUser(deps, { id: 2, first_name: "", username: "only_nick" });
    expect((await s.getUser(deps, 2))?.name).toBe("only_nick");
  });

  it("validates event creation", async () => {
    const { deps } = makeDeps();
    await seedUsers(deps);
    await expectError(s.createEvent(deps, A, "   ", "RUB"), BadRequestError);
    await expectError(s.createEvent(deps, A, "x".repeat(65), "RUB"), BadRequestError);
    await expectError(s.createEvent(deps, A, "Ok", "BTC"), BadRequestError);
    await expectError(s.createEvent(deps, 424242, "Ok", "RUB"), NotFoundError, "Пользователь не найден");
    const { event, members, myNet } = await s.createEvent(deps, A, "  Дача \n у  озера ", "usd");
    expect(event.title).toBe("Дача у озера");
    expect(event.currency).toBe("USD");
    expect(event.inviteCode).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(members.map((m) => m.id)).toEqual([A]);
    expect(myNet).toBe(0);
    const detail = await s.getEventDetail(deps, event.id, A);
    expect(detail.members).toEqual([{ id: A, name: "Алиса Иванова", username: "alice" }]);
  });

  it("join is idempotent and notifies the other members", async () => {
    const { deps, sent } = makeDeps();
    const event = await eventWithThree(deps);
    const again = await s.joinByInviteCode(deps, B, "join_" + event.inviteCode);
    expect(again.joinedNow).toBe(false);
    expect(again.detail.members.map((m) => m.id)).toEqual([A, B, C]);
    // Bob's join notified Alice; Carol's join notified Alice and Bob.
    expect(sent.map((m) => m.userId).sort()).toEqual([A, A, B]);
    expect(sent.every((m) => m.extra?.eventId === event.id)).toBe(true);
    expect(sent[0]!.html).toBe("<b>Боб</b> присоединился(-ась) к событию «Поездка»");
    await expectError(s.joinByInviteCode(deps, B, "nope'; DROP TABLE users;--"), NotFoundError);
    await expectError(s.joinByInviteCode(deps, B, "zzzzzzzzzz"), NotFoundError, "Приглашение не найдено");
    await expectError(s.joinByInviteCode(deps, 424242, event.inviteCode), NotFoundError);
  });

  it("caps members at 40", async () => {
    const { deps, sent } = makeDeps();
    await seedUsers(deps);
    const { event } = await s.createEvent(deps, A, "Большая компания");
    for (let i = 1; i <= 40; i++) await s.upsertUser(deps, { id: 5000 + i, first_name: `U${i}` });
    for (let i = 1; i <= 39; i++) await s.joinByInviteCode(deps, 5000 + i, event.inviteCode);
    expect((await s.getEventDetail(deps, event.id, A)).members).toHaveLength(40);
    await expectError(
      s.joinByInviteCode(deps, 5040, event.inviteCode),
      BadRequestError,
      "В событии уже максимум участников",
    );
    // Existing members can still "join" idempotently.
    expect((await s.joinByInviteCode(deps, 5001, event.inviteCode)).joinedNow).toBe(false);
    expect((await s.getEventDetail(deps, event.id, A)).members).toHaveLength(40);
    expect(sent.some((m) => m.html.includes("U40"))).toBe(false);
  });

  it("permissions: 404 unknown, 403 non-member", async () => {
    const { deps } = makeDeps();
    const event = await eventWithThree(deps);
    await expectError(s.getEventDetail(deps, 999999, A), NotFoundError, "Событие не найдено");
    for (const p of [
      s.getEventDetail(deps, event.id, M),
      s.listExpenses(deps, event.id, M),
      s.getEventBalances(deps, event.id, M),
      s.listSettlements(deps, event.id, M),
      s.addExpense(deps, event.id, M, equal(100, A, [A])),
      s.createSettlement(deps, event.id, M, A, 100),
    ]) {
      await expectError(p, ForbiddenError, "Вы не участник этого события");
    }
  });
});

describe("expenses", () => {
  it("balances sum to zero and transfers settle them", async () => {
    const { deps } = makeDeps();
    const event = await eventWithThree(deps);
    await s.addExpense(deps, event.id, A, equal(1000, A, [A, B, C], "Еда"));
    await s.addExpense(deps, event.id, B, equal(777, B, [B, C], "Такси"));
    await s.addExpense(deps, event.id, C, equal(1, C, [A, B, C], "Жвачка"));
    const nets = await s.computeNets(deps, event.id);
    expect([...nets.values()].reduce((a, b) => a + b, 0)).toBe(0);
    expect(nets.get(A)).toBe(1000 - 334 - 1);
    const balances = await s.getEventBalances(deps, event.id, A);
    expect(balances.balances.map((b) => b.net)).toEqual([...nets.values()].sort((a, b) => b - a));
    const after = new Map(nets);
    for (const t of balances.transfers) {
      after.set(t.from.id, after.get(t.from.id)! + t.amount);
      after.set(t.to.id, after.get(t.to.id)! - t.amount);
    }
    expect([...after.values()].every((v) => v === 0)).toBe(true);
  });

  it("validates expenses", async () => {
    const { deps } = makeDeps();
    const event = await eventWithThree(deps);
    const cases: s.AddExpenseInput[] = [
      equal(0, A, [A]),
      equal(s.MAX_AMOUNT + 1, A, [A]),
      equal(100.5, A, [A]),
      { ...equal(100, A, [A]), description: "" },
      { ...equal(100, A, [A]), description: "x".repeat(101) },
      equal(100, A, []),
      equal(100, A, [A, A]),
      equal(100, M, [A]),
      equal(100, A, [A, M]),
    ];
    for (const c of cases) await expectError(s.addExpense(deps, event.id, B, c), BadRequestError);
    await expectError(s.addExpense(deps, event.id, M, equal(100, A, [A])), ForbiddenError);
    await expectError(s.addExpense(deps, 999, A, equal(100, A, [A])), NotFoundError);
    expect(await s.listExpenses(deps, event.id, A)).toEqual([]);
  });

  it("notifies payer and participants except the actor, with their share, HTML-escaped", async () => {
    const { deps, sent } = makeDeps();
    const event = await eventWithThree(deps);
    sent.length = 0;
    await s.addExpense(deps, event.id, A, equal(150000, B, [A, C], "Ужин <b>"));
    const byUser = Object.fromEntries(sent.map((m) => [m.userId, m.html]));
    expect(Object.keys(byUser).map(Number).sort()).toEqual([B, C]);
    expect(byUser[C]).toContain("1 500 ₽");
    expect(byUser[C]).toContain("Ваша доля: <b>750 ₽</b>");
    expect(byUser[B]).not.toContain("Ваша доля");
    expect(byUser[C]).toContain("Ужин &lt;b&gt;");
    expect(byUser[C]).toBe(
      "<b>Алиса Иванова</b> добавил(а) трату в «Поездка»:\nУжин &lt;b&gt; — <b>1 500 ₽</b>\n" +
        "Заплатил(а): Боб\nВаша доля: <b>750 ₽</b>",
    );
    expect(sent.every((m) => m.extra?.eventId === event.id)).toBe(true);
  });

  it("a throwing notifier does not break a successful write", async () => {
    const { deps } = makeDeps();
    const event = await eventWithThree(deps);
    const broken: s.Deps = {
      ...deps,
      notify: () => {
        throw new Error("telegram is down");
      },
    };
    const view = await s.addExpense(broken, event.id, A, equal(300, A, [A, B, C]));
    expect(view.amount).toBe(300);
  });

  it("delete: only creator or payer", async () => {
    const { deps } = makeDeps();
    const event = await eventWithThree(deps);
    const exp = await s.addExpense(deps, event.id, A, equal(900, B, [A, B, C], "Пицца"));
    await expectError(s.deleteExpense(deps, exp.id, C), ForbiddenError);
    await expectError(s.deleteExpense(deps, exp.id, M), ForbiddenError);
    await s.deleteExpense(deps, exp.id, B); // payer
    expect(await s.listExpenses(deps, event.id, A)).toEqual([]);
    const exp2 = await s.addExpense(deps, event.id, A, equal(900, B, [A, B, C], "Пицца"));
    await s.deleteExpense(deps, exp2.id, A); // creator
    await expectError(s.deleteExpense(deps, exp2.id, A), NotFoundError, "Трата не найдена");
    expect(Object.values(await netsObj(deps, event.id)).every((v) => v === 0)).toBe(true);
    const shares = await env.DB.prepare("SELECT COUNT(*) AS n FROM expense_shares").first<{ n: number }>();
    expect(shares?.n).toBe(0);
  });

  it("exact split happy path", async () => {
    const { deps, sent } = makeDeps();
    const event = await eventWithThree(deps);
    sent.length = 0;
    const view = await s.addExpense(deps, event.id, A, {
      amount: 1000,
      description: "Ужин",
      payerId: A,
      split: "exact",
      shares: [
        { userId: C, amount: 700 },
        { userId: B, amount: 300 },
      ],
    });
    expect(view.split).toBe("exact");
    expect(view.shares.map((x) => [x.user.id, x.amount])).toEqual([
      [B, 300],
      [C, 700],
    ]);
    expect(await netsObj(deps, event.id)).toEqual({ [A]: 1000, [B]: -300, [C]: -700 });
    const balances = await s.getEventBalances(deps, event.id, A);
    expect(balances.transfers.map((t) => [t.from.id, t.to.id, t.amount])).toEqual([
      [C, A, 700],
      [B, A, 300],
    ]);
    const byUser = Object.fromEntries(sent.map((m) => [m.userId, m.html]));
    expect(Object.keys(byUser).map(Number).sort()).toEqual([B, C]);
    expect(byUser[B]).toContain("Ваша доля: <b>3 ₽</b>");
    expect(byUser[C]).toContain("Ваша доля: <b>7 ₽</b>");

    await s.addExpense(deps, event.id, B, {
      amount: 500,
      description: "Такси",
      payerId: B,
      split: "exact",
      shares: [
        { userId: A, amount: 250 },
        { userId: B, amount: 250 },
      ],
    });
    const listed = await s.listExpenses(deps, event.id, A);
    expect(listed.map((x) => x.split)).toEqual(["exact", "exact"]);
    expect(listed[0]!.description).toBe("Такси");
    expect(await netsObj(deps, event.id)).toEqual({ [A]: 750, [B]: -50, [C]: -700 });
  });

  it("equal split is the default", async () => {
    const { deps } = makeDeps();
    const event = await eventWithThree(deps);
    const view = await s.addExpense(deps, event.id, A, equal(101, A, [B, A]));
    expect(view.split).toBe("equal");
    expect(view.shares.map((x) => x.amount)).toEqual([51, 50]);
  });

  it.each<[Partial<s.AddExpenseInput>, string]>([
    [
      { split: "exact", shares: [{ userId: A, amount: 600 }, { userId: B, amount: 300 }] },
      "Сумма долей (9 ₽) не совпадает с суммой траты (10 ₽)",
    ],
    [
      { split: "exact", shares: [{ userId: A, amount: 1000 }, { userId: B, amount: 0 }] },
      "Доля каждого участника должна быть больше нуля",
    ],
    [
      { split: "exact", shares: [{ userId: A, amount: 1100 }, { userId: B, amount: -100 }] },
      "Доля каждого участника должна быть больше нуля",
    ],
    [
      { split: "exact", shares: [{ userId: A, amount: 500 }, { userId: A, amount: 500 }] },
      "Участники не должны повторяться",
    ],
    [{ split: "exact", shares: [] }, "Укажите доли участников"],
    [{ split: "exact" }, "Укажите доли участников"],
    [
      { split: "exact", shares: [{ userId: A, amount: 500 }, { userId: M, amount: 500 }] },
      "Все участники траты должны быть участниками события",
    ],
    [
      { split: "exact", shares: [{ userId: A, amount: 1000 }], participantIds: [A] },
      "При точном делении укажите доли, а не список участников",
    ],
    [
      { split: "exact", shares: [{ userId: A, amount: 1000 }], participantIds: [] },
      "При точном делении укажите доли, а не список участников",
    ],
    [{ participantIds: [A], shares: [{ userId: A, amount: 1000 }] }, "При равном делении доли не указываются"],
    [{ participantIds: [A], shares: [] }, "При равном делении доли не указываются"],
    [{ split: "weird", participantIds: [A] }, "Неизвестный способ деления траты"],
  ])("exact split validation %#", async (extra, message) => {
    const { deps } = makeDeps();
    const event = await eventWithThree(deps);
    await expectError(
      s.addExpense(deps, event.id, A, { amount: 1000, description: "x", payerId: A, ...extra }),
      BadRequestError,
      message,
    );
    expect(await s.listExpenses(deps, event.id, A)).toEqual([]);
  });
});

describe("settlements", () => {
  it("full flow: only the recipient confirms; confirmed changes balances", async () => {
    const { deps, sent } = makeDeps();
    const event = await eventWithThree(deps);
    await s.addExpense(deps, event.id, A, equal(3000, A, [A, B, C], "Билеты"));
    expect((await s.computeNets(deps, event.id)).get(B)).toBe(-1000);

    sent.length = 0;
    const st = await s.createSettlement(deps, event.id, B, A, 1000);
    expect(st.status).toBe("pending");
    expect(sent.map((m) => m.userId)).toEqual([A]);
    expect(sent[0]!.html).toBe("<b>Боб</b> отметил(а), что вернул(а) вам <b>10 ₽</b> в «Поездка» — подтвердите");
    expect((await s.computeNets(deps, event.id)).get(B)).toBe(-1000);

    await expectError(s.confirmSettlement(deps, st.id, B), ForbiddenError);
    await expectError(s.confirmSettlement(deps, st.id, C), ForbiddenError);
    await expectError(s.confirmSettlement(deps, st.id, M), ForbiddenError);
    await expectError(s.confirmSettlement(deps, 424242, A), NotFoundError, "Перевод не найден");

    sent.length = 0;
    const done = await s.confirmSettlement(deps, st.id, A);
    expect(done.status).toBe("confirmed");
    expect(done.resolvedAt).not.toBeNull();
    expect(sent.map((m) => m.userId)).toEqual([B]);
    expect(sent[0]!.html).toBe("<b>Алиса Иванова</b> подтвердил(а) получение <b>10 ₽</b> в «Поездка»");
    expect(await netsObj(deps, event.id)).toEqual({ [A]: 1000, [B]: 0, [C]: -1000 });
    await expectError(s.rejectSettlement(deps, st.id, A), BadRequestError, "Этот возврат уже обработан");

    sent.length = 0;
    const st2 = await s.createSettlement(deps, event.id, C, A, 500);
    const rejected = await s.rejectSettlement(deps, st2.id, A);
    expect(rejected.status).toBe("rejected");
    expect(sent.at(-1)).toMatchObject({ userId: C, extra: { eventId: event.id } });
    expect(sent.at(-1)!.html).toContain("отклонил(а) ваш перевод <b>5 ₽</b>");
    expect((await s.computeNets(deps, event.id)).get(C)).toBe(-1000);
    expect((await s.listSettlements(deps, event.id, C)).map((x) => x.id)).toEqual([st2.id, st.id]);
  });

  it("validation", async () => {
    const { deps } = makeDeps();
    const event = await eventWithThree(deps);
    await expectError(s.createSettlement(deps, event.id, A, A, 100), BadRequestError, "Нельзя вернуть деньги самому себе");
    await expectError(
      s.createSettlement(deps, event.id, A, M, 100),
      BadRequestError,
      "Получатель должен быть участником события",
    );
    await expectError(s.createSettlement(deps, event.id, A, B, -5), BadRequestError);
    await expectError(s.createSettlement(deps, event.id, M, A, 100), ForbiddenError);
  });

  it("is capped by the debt and one pending per pair", async () => {
    const { deps } = makeDeps();
    const event = await eventWithThree(deps);
    const tooMuch = "Сумма больше вашего долга этому участнику";
    await expectError(s.createSettlement(deps, event.id, B, A, 100), BadRequestError, tooMuch);

    await s.addExpense(deps, event.id, A, equal(3000, A, [A, B, C], "Билеты"));
    expect(s.debtTo(await s.computeNets(deps, event.id), B, A)).toBe(1000);
    await expectError(s.createSettlement(deps, event.id, B, A, 1001), BadRequestError, tooMuch);
    await expectError(s.createSettlement(deps, event.id, B, C, 1), BadRequestError, tooMuch);
    await expectError(s.createSettlement(deps, event.id, A, B, 1), BadRequestError, tooMuch);

    const first = await s.createSettlement(deps, event.id, B, A, 400);
    await expectError(
      s.createSettlement(deps, event.id, B, A, 100),
      BadRequestError,
      "Предыдущий возврат ещё ждёт подтверждения",
    );
    await s.createSettlement(deps, event.id, C, A, 1000); // other pairs are independent

    await s.confirmSettlement(deps, first.id, A);
    expect(s.debtTo(await s.computeNets(deps, event.id), B, A)).toBe(600);
    await expectError(s.createSettlement(deps, event.id, B, A, 601), BadRequestError, tooMuch);
    await s.createSettlement(deps, event.id, B, A, 600);
  });

  it("double confirm/reject: exactly one wins (atomic conditional update)", async () => {
    const { deps } = makeDeps();
    const event = await eventWithThree(deps);
    await s.addExpense(deps, event.id, A, equal(3000, A, [A, B, C], "Билеты"));
    const st = await s.createSettlement(deps, event.id, B, A, 1000);
    const results = await Promise.allSettled([
      s.confirmSettlement(deps, st.id, A),
      s.rejectSettlement(deps, st.id, A),
      s.confirmSettlement(deps, st.id, A),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(2);
    for (const f of failed) expect((f.reason as Error).message).toBe("Этот возврат уже обработан");
  });

  it("the database allows a single pending settlement per pair", async () => {
    const { deps } = makeDeps();
    const event = await eventWithThree(deps);
    const insert = (status: string, amount: number) =>
      env.DB.prepare(
        "INSERT INTO settlements (event_id, from_id, to_id, amount, status, created_at) VALUES (?, ?, ?, ?, ?, 0)",
      )
        .bind(event.id, B, A, amount, status)
        .run();
    await insert("pending", 1);
    await insert("confirmed", 1); // non-pending duplicates are fine
    await expect(insert("pending", 2)).rejects.toThrow(/UNIQUE/);
    await expect(insert("weird", 2)).rejects.toThrow(/CHECK/);
  });
});

describe("bot helpers", () => {
  it("debts summary and reminders", async () => {
    const { deps } = makeDeps();
    const event = await eventWithThree(deps);
    await s.addExpense(deps, event.id, A, equal(3000, A, [A, B, C], "Билеты"));

    const summary = await s.getUserDebtsSummary(deps, B);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ eventId: event.id, title: "Поездка", currency: "RUB", net: -1000, owedBy: [] });
    expect(summary[0]!.owes.map((t) => [t.toUser.id, t.amount])).toEqual([[A, 1000]]);
    const alice = (await s.getUserDebtsSummary(deps, A))[0]!;
    expect(alice.owedBy.map((t) => [t.fromUser.id, t.amount]).sort()).toEqual([
      [B, 1000],
      [C, 1000],
    ]);
    expect(alice.owedBy[0]!.fromUser.name).toBe("Боб");

    const now = Date.now();
    const day = 24 * 3600 * 1000;
    const due = await s.findDebtorsToRemind(deps, now, 3, 50);
    expect(due).toEqual([
      { eventId: event.id, eventTitle: "Поездка", currency: "RUB", userId: B, amount: 1000 },
      { eventId: event.id, eventTitle: "Поездка", currency: "RUB", userId: C, amount: 1000 },
    ]);
    expect(await s.findDebtorsToRemind(deps, now, 3, 1)).toHaveLength(1);

    await s.markReminded(deps, event.id, B, now);
    expect((await s.findDebtorsToRemind(deps, now + day, 3)).map((r) => r.userId)).toEqual([C]);
    // Never-reminded debtors come first, then the least recently reminded.
    expect((await s.findDebtorsToRemind(deps, new Date(now + 3 * day + 60_000), 3)).map((r) => r.userId)).toEqual([
      C,
      B,
    ]);
    expect((await s.findDebtorsToRemind(deps, now + 3 * day + 60_000, 3, 1)).map((r) => r.userId)).toEqual([C]);

    // Carol reported a payback that is still pending: she is not reminded.
    const st = await s.createSettlement(deps, event.id, C, A, 500);
    expect((await s.findDebtorsToRemind(deps, now + 4 * day, 3)).map((r) => r.userId)).toEqual([B]);
    await s.rejectSettlement(deps, st.id, A);
    expect((await s.findDebtorsToRemind(deps, now + 4 * day, 3)).map((r) => r.userId)).toEqual([C, B]);

    await s.markRemindedMany(deps, [{ eventId: event.id, userId: B }, { eventId: event.id, userId: C }], now + 4 * day);
    expect(await s.findDebtorsToRemind(deps, now + 5 * day, 3)).toEqual([]);
    // Least recently reminded first, regardless of user id.
    await s.markReminded(deps, event.id, B, now + 10 * day);
    await s.markReminded(deps, event.id, C, now + 9 * day);
    expect((await s.findDebtorsToRemind(deps, now + 20 * day, 3)).map((r) => r.userId)).toEqual([C, B]);
    expect((await s.findDebtorsToRemind(deps, now + 20 * day, 3, 1)).map((r) => r.userId)).toEqual([C]);
    await expectError(s.markReminded(deps, 999999, B, now), NotFoundError);

    const events = await s.listUserEvents(deps, B);
    expect(events).toEqual([{ id: event.id, title: "Поездка", currency: "RUB", membersCount: 3, myNet: -1000 }]);
    expect(await s.getUserDebtsSummary(deps, M)).toEqual([]);
  });

  it("caps events per owner at 50", async () => {
    const { deps } = makeDeps();
    await seedUsers(deps);
    await env.DB.batch(
      Array.from({ length: 49 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO events (title, currency, invite_code, owner_id, created_at) VALUES (?, 'RUB', ?, ?, 0)",
        ).bind(`E${i}`, `code${String(i).padStart(6, "0")}`, A),
      ),
    );
    await s.createEvent(deps, A, "50-е"); // the 50th is allowed
    await expectError(s.createEvent(deps, A, "51-е"), BadRequestError, "Слишком много событий (максимум 50)");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE owner_id = ?").bind(A).first<{ n: number }>();
    expect(n?.n).toBe(50);
    expect((await s.createEvent(deps, B, "Своё")).event.ownerId).toBe(B); // other owners unaffected
  });

  it("caps expenses per event at 1000", async () => {
    const { deps } = makeDeps();
    const event = await eventWithThree(deps);
    const stmt = env.DB.prepare(
      `INSERT INTO expenses (event_id, payer_id, amount, description, split_mode, created_by, created_at)
       VALUES (?, ?, 1, 'x', 'equal', ?, 0)`,
    );
    await env.DB.batch(Array.from({ length: 999 }, () => stmt.bind(event.id, A, A)));
    await s.addExpense(deps, event.id, A, equal(100, A, [A])); // the 1000th is allowed
    await expectError(
      s.addExpense(deps, event.id, A, equal(100, A, [A])),
      BadRequestError,
      "В событии слишком много трат (максимум 1000)",
    );
  });

  it("lists events newest first", async () => {
    const { deps } = makeDeps();
    await s.upsertUser(deps, ALICE);
    const first = await s.createEvent(deps, A, "Первое");
    const second = await s.createEvent(deps, A, "Второе", "EUR");
    expect((await s.listUserEvents(deps, A)).map((e) => e.id)).toEqual([second.event.id, first.event.id]);
  });
});
