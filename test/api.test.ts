import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api/app";
import { createNotifier } from "../src/core/notify";
import { A, ALICE, B, BOB, C, CAROL, M, MALLORY, apiClient, authHeaders, makeInitData } from "./helpers";

const ORIGIN = "https://prostoyus.github.io";

async function eventAB(call: ReturnType<typeof apiClient>["call"]): Promise<number> {
  const created = await call("POST", "/api/events", ALICE, { title: "Т" });
  await call("POST", "/api/join", BOB, { invite_code: created.json.invite_code });
  return created.json.id;
}

describe("auth and basics", () => {
  it("health works without auth", async () => {
    const { call } = apiClient();
    const r = await call("GET", "/api/health");
    expect([r.status, r.json]).toEqual([200, { ok: true }]);
  });

  it("requires valid, fresh initData", async () => {
    const { call } = apiClient();
    let r = await call("GET", "/api/me");
    expect(r.status).toBe(401);
    expect(r.json.detail).toContain("Telegram");
    r = await call("GET", "/api/me", undefined, undefined, { "X-Telegram-Init-Data": "user=1&hash=abc&auth_date=1" });
    expect(r.status).toBe(401);
    const old = await makeInitData(ALICE, { authDate: Math.floor(Date.now() / 1000) - 90000 });
    r = await call("GET", "/api/me", undefined, undefined, { "X-Telegram-Init-Data": old });
    expect(r.status).toBe(401);
    expect(r.json.detail).toContain("устарела");
    const forged = await makeInitData(ALICE, { token: "999:other" });
    r = await call("GET", "/api/me", undefined, undefined, { "X-Telegram-Init-Data": forged });
    expect(r.status).toBe(401);
  });

  it("me and config", async () => {
    const { call } = apiClient();
    expect((await call("GET", "/api/me", ALICE)).json).toEqual({ id: A, name: "Алиса Иванова", username: "alice" });
    expect((await call("GET", "/api/config", ALICE)).json).toEqual({ bot_username: "split_test_bot" });
  });

  it("rate limits per user", async () => {
    const { call } = apiClient({ rateLimitPerMinute: 3 });
    for (let i = 0; i < 3; i++) expect((await call("GET", "/api/me", ALICE)).status).toBe(200);
    const r = await call("GET", "/api/me", ALICE);
    expect(r.status).toBe(429);
    expect(r.json.detail).toContain("Слишком много запросов");
    expect((await call("GET", "/api/me", BOB)).status).toBe(200);
  });

  it("validation errors are in Russian", async () => {
    const { call } = apiClient();
    let r = await call("POST", "/api/events", ALICE, { title: 123 });
    expect([r.status, r.json.detail]).toEqual([422, "Некорректное название события"]);
    r = await call("POST", "/api/events", ALICE, { title: "x", currency: "BTC" });
    expect(r.status).toBe(400);
    expect(r.json.detail).toContain("валюта");
    r = await call("POST", "/api/events", ALICE, "not an object");
    expect(r.status).toBe(422);
    r = await call("GET", "/api/events/abc", ALICE);
    expect([r.status, r.json.detail]).toEqual([422, "Некорректный номер события"]);
    r = await call("GET", "/api/events/0", ALICE);
    expect(r.status).toBe(422);
    r = await call("GET", "/api/events/99999", ALICE);
    expect([r.status, r.json.detail]).toEqual([404, "Событие не найдено"]);
    r = await call("GET", "/api/nope", ALICE);
    expect([r.status, r.json.detail]).toEqual([404, "Не найдено"]);
    r = await call("POST", "/api/join", ALICE, { invite_code: 5 });
    expect([r.status, r.json.detail]).toEqual([422, "Некорректный код приглашения"]);
    r = await call("POST", "/api/events/1/settlements", ALICE, { to_id: "1", amount: 1 });
    expect([r.status, r.json.detail]).toEqual([422, "Некорректный получатель"]);
  });
});

describe("rename event", () => {
  it("PATCH /api/events/{id}", async () => {
    const { call, sent } = apiClient();
    const created = await call("POST", "/api/events", ALICE, { title: "Старое" });
    const eid = created.json.id;
    await call("POST", "/api/join", BOB, { invite_code: created.json.invite_code });
    sent.length = 0;

    let r = await call("PATCH", `/api/events/${eid}`, ALICE, { title: " Новое " });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ...created.json, title: "Новое", members: r.json.members });
    expect(Object.keys(r.json).sort()).toEqual(
      ["currency", "id", "invite_code", "invite_link", "members", "my_net", "owner_id", "title"].sort(),
    );
    expect(r.json.members.map((m: any) => m.id)).toEqual([A, B]);
    expect(sent).toEqual([
      {
        userId: B,
        html: "<b>Алиса Иванова</b> переименовал(а) событие «Старое» в «Новое»",
        extra: { eventId: eid },
      },
    ]);

    sent.length = 0;
    r = await call("PATCH", `/api/events/${eid}`, ALICE, { title: "Новое" });
    expect([r.status, r.json.title, sent.length]).toEqual([200, "Новое", 0]);

    r = await call("PATCH", `/api/events/${eid}`, BOB, { title: "Моё" });
    expect([r.status, r.json.detail]).toEqual([403, "Переименовать событие может только его создатель"]);
    r = await call("PATCH", `/api/events/${eid}`, MALLORY, { title: "Моё" });
    expect([r.status, r.json.detail]).toEqual([403, "Вы не участник этого события"]);
    r = await call("PATCH", "/api/events/999999", ALICE, { title: "Моё" });
    expect([r.status, r.json.detail]).toEqual([404, "Событие не найдено"]);
    r = await call("PATCH", "/api/events/abc", ALICE, { title: "Моё" });
    expect(r.status).toBe(422);
    r = await call("PATCH", `/api/events/${eid}`, ALICE, { title: "  " });
    expect([r.status, r.json.detail]).toEqual([400, "Поле «название» не может быть пустым"]);
    r = await call("PATCH", `/api/events/${eid}`, ALICE, { title: "x".repeat(65) });
    expect(r.status).toBe(400);
    r = await call("PATCH", `/api/events/${eid}`, ALICE, { title: "x".repeat(501) });
    expect([r.status, r.json.detail]).toEqual([422, "Некорректное название события"]);
    r = await call("PATCH", `/api/events/${eid}`, ALICE, { title: 5 });
    expect([r.status, r.json.detail]).toEqual([422, "Некорректное название события"]);
    r = await call("PATCH", `/api/events/${eid}`, ALICE, {});
    expect(r.status).toBe(422);
    r = await call("PATCH", `/api/events/${eid}`);
    expect(r.status).toBe(401);
    expect(sent).toEqual([]);
    expect((await call("GET", `/api/events/${eid}`, BOB)).json.title).toBe("Новое");
  });

  it("preflight from an allowed origin lists PATCH", async () => {
    const { call } = apiClient();
    const r = await call("OPTIONS", "/api/events/1", undefined, undefined, {
      Origin: ORIGIN,
      "Access-Control-Request-Method": "PATCH",
      "Access-Control-Request-Headers": "X-Telegram-Init-Data, Content-Type",
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(r.headers.get("access-control-allow-methods")?.split(/,\s*/)).toContain("PATCH");
  });
});

describe("body size limit", () => {
  const post = async (body: BodyInit, extraHeaders: Record<string, string> = {}) => {
    const app = createApi();
    const res = await app.request(
      "/api/events",
      {
        method: "POST",
        headers: { ...(await authHeaders(ALICE)), "Content-Type": "application/json", ...extraHeaders },
        body,
      },
      env,
    );
    return { status: res.status, json: await res.json<any>() };
  };

  it("counts bytes, not characters", async () => {
    // 30k Cyrillic chars = 60k bytes (fits); 40k = 80k bytes (too large although < 64k chars).
    const ok = await post(JSON.stringify({ title: "Т", pad: "я".repeat(30_000) }));
    expect(ok.status).toBe(200);
    const big = await post(JSON.stringify({ title: "Т", pad: "я".repeat(40_000) }));
    expect([big.status, big.json.detail]).toEqual([413, "Слишком большой запрос"]);
  });

  it("does not trust a missing Content-Length (streamed body)", async () => {
    const chunk = new TextEncoder().encode(" ".repeat(16 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 8) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const r = await post(stream);
    expect([r.status, r.json.detail]).toEqual([413, "Слишком большой запрос"]);
  });

  it("rejects a declared oversize Content-Length up front", async () => {
    const r = await post("{}", { "Content-Length": String(10 * 1024 * 1024) });
    expect(r.status).toBe(413);
  });

  it("rejects invalid UTF-8", async () => {
    const r = await post(new Uint8Array([0x7b, 0xff, 0x7d]));
    expect(r.status).toBe(422);
  });
});

describe("CORS", () => {
  it.each([
    [ORIGIN, true],
    ["http://localhost:5500", true],
    ["http://127.0.0.1:8000", true],
    ["https://evil.example.com", false],
    ["https://prostoyus.github.io.evil.com", false],
  ])("preflight from %s allowed=%s", async (origin, allowed) => {
    const { call } = apiClient();
    const r = await call("OPTIONS", "/api/events", undefined, undefined, {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "X-Telegram-Init-Data, Content-Type",
    });
    expect(r.headers.get("access-control-allow-origin") === origin).toBe(allowed);
    if (allowed) {
      expect(r.headers.get("access-control-allow-headers")).toContain("X-Telegram-Init-Data");
      expect(r.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });

  it("adds CORS headers to normal and error responses", async () => {
    const { call } = apiClient();
    let r = await call("GET", "/api/health", undefined, undefined, { Origin: ORIGIN });
    expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    r = await call("GET", "/api/me", undefined, undefined, { Origin: ORIGIN });
    expect(r.status).toBe(401);
    expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    r = await call("GET", "/api/health", undefined, undefined, { Origin: "https://evil.example.com" });
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("unexpected errors are JSON 500 with CORS headers", async () => {
    const { call } = apiClient({
      deps: () => {
        throw new Error("forced failure");
      },
    });
    const r = await call("GET", "/api/me", ALICE, undefined, { Origin: ORIGIN });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ detail: "Внутренняя ошибка сервера" });
    expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });
});

describe("split modes over HTTP", () => {
  it("exact and equal", async () => {
    const { call } = apiClient();
    const eid = await eventAB(call);
    let r = await call("POST", `/api/events/${eid}/expenses`, ALICE, {
      amount: 150050,
      description: "Отель",
      payer_id: A,
      split: "exact",
      shares: [
        { user_id: B, amount: 100050 },
        { user_id: A, amount: 50000 },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.json.split).toBe("exact");
    expect(r.json.shares.map((x: any) => [x.user.id, x.amount])).toEqual([
      [A, 50000],
      [B, 100050],
    ]);
    expect(r.json.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

    r = await call("POST", `/api/events/${eid}/expenses`, ALICE, {
      amount: 100,
      description: "Старый клиент",
      payer_id: B,
      participant_ids: [A, B],
    });
    expect([r.status, r.json.split]).toEqual([200, "equal"]);

    const listed = (await call("GET", `/api/events/${eid}/expenses`, ALICE)).json;
    expect(listed.map((x: any) => x.split)).toEqual(["equal", "exact"]);
    const bal = (await call("GET", `/api/events/${eid}/balances`, ALICE)).json;
    expect(Object.fromEntries(bal.balances.map((x: any) => [x.user.id, x.net]))).toEqual({ [A]: 100000, [B]: -100000 });
  });

  it("errors", async () => {
    const { call } = apiClient();
    const eid = await eventAB(call);
    const base = { amount: 1000, description: "x", payer_id: A, split: "exact" };
    const cases: [object, number, string][] = [
      [
        { shares: [{ user_id: A, amount: 400 }, { user_id: B, amount: 500 }] },
        400,
        "Сумма долей (9 ₽) не совпадает с суммой траты (10 ₽)",
      ],
      [
        { shares: [{ user_id: A, amount: 1000 }, { user_id: B, amount: 0 }] },
        400,
        "Доля каждого участника должна быть больше нуля",
      ],
      [
        { shares: [{ user_id: A, amount: 1500 }, { user_id: B, amount: -500 }] },
        400,
        "Доля каждого участника должна быть больше нуля",
      ],
      [{ shares: [{ user_id: A, amount: 500 }, { user_id: A, amount: 500 }] }, 400, "Участники не должны повторяться"],
      [
        { shares: [{ user_id: A, amount: 500 }, { user_id: M, amount: 500 }] },
        400,
        "Все участники траты должны быть участниками события",
      ],
      [
        { shares: [{ user_id: A, amount: 1000 }], participant_ids: [A] },
        400,
        "При точном делении укажите доли, а не список участников",
      ],
      [
        { shares: [{ user_id: A, amount: 1000 }], participant_ids: [] },
        400,
        "При точном делении укажите доли, а не список участников",
      ],
      [
        { split: "equal", participant_ids: [A], shares: [{ user_id: A, amount: 1000 }] },
        400,
        "При равном делении доли не указываются",
      ],
      [
        { split: null, participant_ids: [A], shares: [{ user_id: A, amount: 1000 }] },
        400,
        "При равном делении доли не указываются",
      ],
      [{ split: "equal", participant_ids: [A], shares: [] }, 400, "При равном делении доли не указываются"],
      [{ shares: [] }, 400, "Укажите доли участников"],
      [{}, 400, "Укажите доли участников"],
      [{ shares: null }, 400, "Укажите доли участников"],
      [{ split: "percent", participant_ids: [A] }, 422, "Некорректный способ деления: допустимо «equal» или «exact»"],
      [{ shares: [{ user_id: A, amount: 10.5 }] }, 422, "Некорректный список долей"],
      [{ shares: [{ amount: 1000 }] }, 422, "Некорректный список долей"],
      [{ shares: "x" }, 422, "Некорректный список долей"],
    ];
    for (const [extra, status, detail] of cases) {
      const r = await call("POST", `/api/events/${eid}/expenses`, ALICE, { ...base, ...extra });
      expect([r.status, r.json.detail], JSON.stringify(extra)).toEqual([status, detail]);
    }
    const r = await call("POST", `/api/events/${eid}/expenses`, MALLORY, {
      ...base,
      shares: [{ user_id: A, amount: 1000 }],
    });
    expect(r.status).toBe(403);
    expect((await call("GET", `/api/events/${eid}/expenses`, ALICE)).json).toEqual([]);
  });
});

describe("settlement rules over HTTP", () => {
  it("cap by debt and one pending per pair", async () => {
    const { call } = apiClient();
    const eid = await eventAB(call);
    await call("POST", `/api/events/${eid}/expenses`, ALICE, {
      amount: 1000,
      description: "x",
      payer_id: A,
      participant_ids: [A, B],
    });
    let r = await call("POST", `/api/events/${eid}/settlements`, BOB, { to_id: A, amount: 501 });
    expect([r.status, r.json.detail]).toEqual([400, "Сумма больше вашего долга этому участнику"]);
    r = await call("POST", `/api/events/${eid}/settlements`, BOB, { to_id: A, amount: 200 });
    expect(r.status).toBe(200);
    r = await call("POST", `/api/events/${eid}/settlements`, BOB, { to_id: A, amount: 100 });
    expect([r.status, r.json.detail]).toEqual([400, "Предыдущий возврат ещё ждёт подтверждения"]);
  });
});

describe("end to end", () => {
  it("three users", async () => {
    const { call, sent } = apiClient();

    // Alice creates an event.
    let r = await call("POST", "/api/events", ALICE, { title: "Поездка в Казань" });
    expect(r.status).toBe(200);
    const event = r.json;
    const eid: number = event.id;
    const code: string = event.invite_code;
    expect(event).toMatchObject({ currency: "RUB", owner_id: A, my_net: 0 });
    expect(event.invite_link).toBe(`https://t.me/split_test_bot?start=join_${code}`);
    expect(event.members.map((m: any) => m.id)).toEqual([A]);

    // Bob and Carol join (idempotent).
    for (const u of [BOB, CAROL, BOB]) {
      r = await call("POST", "/api/join", u, { invite_code: code });
      expect(r.status).toBe(200);
    }
    expect(r.json.members.map((m: any) => m.id)).toEqual([A, B, C]);
    expect((await call("POST", "/api/join", BOB, { invite_code: "wrongcode1" })).status).toBe(404);
    expect(sent.map((m) => m.userId).sort()).toEqual([A, A, B]);

    // Mallory is not a member.
    for (const path of ["", "/expenses", "/balances", "/settlements"]) {
      expect((await call("GET", `/api/events/${eid}${path}`, MALLORY)).status, path).toBe(403);
    }
    r = await call("POST", `/api/events/${eid}/expenses`, MALLORY, {
      amount: 100,
      description: "x",
      payer_id: A,
      participant_ids: [A],
    });
    expect(r.status).toBe(403);

    // Alice pays 1000.00 for all three -> 333.34 / 333.33 / 333.33.
    sent.length = 0;
    r = await call("POST", `/api/events/${eid}/expenses`, ALICE, {
      amount: 100000,
      description: "Отель",
      payer_id: A,
      participant_ids: [C, B, A],
    });
    expect(r.status).toBe(200);
    const exp = r.json;
    expect(exp.payer.id).toBe(A);
    expect(exp.created_by).toBe(A);
    expect(exp.shares.map((x: any) => [x.user.id, x.amount])).toEqual([
      [A, 33334],
      [B, 33333],
      [C, 33333],
    ]);
    expect(sent.map((m) => m.userId).sort()).toEqual([B, C]);

    // Bad expenses.
    const bad = [
      { amount: 10.5, description: "x", payer_id: A, participant_ids: [A] },
      { amount: "100", description: "x", payer_id: A, participant_ids: [A] },
      { amount: 100, description: "x", payer_id: A, participant_ids: [] },
      { amount: 100, description: "x", payer_id: A, participant_ids: [A, A] },
      { amount: 100, description: "x", payer_id: M, participant_ids: [A] },
      { amount: 100, description: "x", payer_id: A, participant_ids: [M] },
      { amount: 1e20, description: "x", payer_id: A, participant_ids: [A] },
      { amount: 100, description: "x", payer_id: A, participant_ids: ["1001"] },
      { amount: 100, description: 5, payer_id: A, participant_ids: [A] },
      { amount: 100, description: "x", payer_id: true, participant_ids: [A] },
    ];
    for (const body of bad) {
      r = await call("POST", `/api/events/${eid}/expenses`, ALICE, body);
      expect([400, 422], JSON.stringify(body)).toContain(r.status);
      expect(typeof r.json.detail).toBe("string");
    }

    // Balances.
    const bal = (await call("GET", `/api/events/${eid}/balances`, BOB)).json;
    const nets = Object.fromEntries(bal.balances.map((x: any) => [x.user.id, x.net]));
    expect(nets).toEqual({ [A]: 66666, [B]: -33333, [C]: -33333 });
    expect(bal.transfers.map((t: any) => [t.from.id, t.to.id, t.amount])).toEqual([
      [B, A, 33333],
      [C, A, 33333],
    ]);

    // Events list.
    expect((await call("GET", "/api/events", BOB)).json).toEqual([
      { id: eid, title: "Поездка в Казань", currency: "RUB", members_count: 3, my_net: -33333 },
    ]);

    // Bob pays back; only Alice may confirm.
    sent.length = 0;
    r = await call("POST", `/api/events/${eid}/settlements`, BOB, { to_id: A, amount: 33333 });
    expect(r.status).toBe(200);
    const st = r.json;
    expect(st).toMatchObject({ status: "pending", from: { id: B }, to: { id: A }, amount: 33333 });
    expect(sent.map((m) => m.userId)).toEqual([A]);
    expect((await call("POST", `/api/events/${eid}/settlements`, BOB, { to_id: B, amount: 1 })).status).toBe(400);
    for (const u of [BOB, CAROL, MALLORY]) {
      expect((await call("POST", `/api/settlements/${st.id}/confirm`, u)).status).toBe(403);
    }
    r = await call("POST", `/api/settlements/${st.id}/confirm`, ALICE);
    expect([r.status, r.json.status]).toEqual([200, "confirmed"]);
    expect((await call("POST", `/api/settlements/${st.id}/reject`, ALICE)).status).toBe(400);
    expect((await call("POST", "/api/settlements/424242/confirm", ALICE)).status).toBe(404);

    const after = (await call("GET", `/api/events/${eid}/balances`, ALICE)).json;
    expect(Object.fromEntries(after.balances.map((x: any) => [x.user.id, x.net]))).toEqual({
      [A]: 33333,
      [B]: 0,
      [C]: -33333,
    });
    expect((await call("GET", `/api/events/${eid}/settlements`, CAROL)).json.map((x: any) => x.id)).toEqual([st.id]);

    // Delete permissions.
    expect((await call("DELETE", `/api/expenses/${exp.id}`, CAROL)).status).toBe(403);
    expect((await call("DELETE", `/api/expenses/${exp.id}`, MALLORY)).status).toBe(403);
    r = await call("DELETE", `/api/expenses/${exp.id}`, ALICE);
    expect([r.status, r.json]).toEqual([200, { ok: true }]);
    expect((await call("GET", `/api/events/${eid}/expenses`, BOB)).json).toEqual([]);

    // The confirmed settlement remains: Bob is now owed back.
    expect((await call("GET", `/api/events/${eid}`, BOB)).json.my_net).toBe(33333);
  });
});

describe("worker entry and waitUntil notifier", () => {
  it("SELF fetch through src/index.ts", async () => {
    let r = await exports.default.fetch("https://split-bot.example/api/health");
    expect(await r.json()).toEqual({ ok: true });
    r = await exports.default.fetch("https://split-bot.example/api/me", { headers: await authHeaders(ALICE) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: A, name: "Алиса Иванова", username: "alice" });
  });

  it("createNotifier delivers via waitUntil and swallows errors", async () => {
    const delivered: number[] = [];
    const ctx = createExecutionContext();
    const app = createApi({
      deps: (e, c) => ({
        db: e.DB,
        botUsername: "split_test_bot",
        notify: createNotifier(c!.waitUntil.bind(c), async (userId) => {
          if (userId === B) throw new Error("bot was blocked by the user");
          delivered.push(userId);
        }),
      }),
    });
    const send = async (user: object, path: string, body: unknown) =>
      app.request(
        path,
        {
          method: "POST",
          headers: { ...(await authHeaders(user)), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        env,
        ctx,
      );
    const created = await (await send(ALICE, "/api/events", { title: "Т" })).json<any>();
    await send(BOB, "/api/join", { invite_code: created.invite_code });
    await send(CAROL, "/api/join", { invite_code: created.invite_code });
    await waitOnExecutionContext(ctx);
    // Carol's join notifies Alice and Bob; Bob's delivery fails silently.
    expect(delivered.sort()).toEqual([A, A]);
  });
});
