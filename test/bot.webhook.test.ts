import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as s from "../src/core/services";
import { ERROR_TEXT, GREETING_TEXT, HELP_TEXT, INVITE_NOT_FOUND_TEXT, UNKNOWN_TEXT } from "../src/bot/texts";
import worker from "../src/index";
import { WEBHOOK_SECRET, mockTelegram, messageUpdate, postUpdate, tgError, workerFetch } from "./bot.helpers";
import { A, ALICE, B, BOB, CAROL, makeDeps } from "./helpers";

const WEBAPP = "https://prostoyus.github.io/split-bot/webapp/";

afterEach(() => {
  vi.restoreAllMocks();
});

async function userExists(id: number): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 FROM users WHERE id = ?1").bind(id).first()) !== null;
}

function button(call: { payload: any }) {
  return call.payload.reply_markup?.inline_keyboard?.[0]?.[0];
}

describe("webhook auth", () => {
  it("rejects a missing secret with 401 and does nothing", async () => {
    const tg = mockTelegram();
    const res = await postUpdate(messageUpdate(ALICE, "/start"), null);
    expect(res.status).toBe(401);
    expect(tg.calls).toEqual([]);
    expect(await userExists(A)).toBe(false);
  });

  it("rejects a wrong secret with 401 and does nothing", async () => {
    const tg = mockTelegram();
    for (const secret of ["nope", "test-webhook-secret-0123456789abcdeX", ""]) {
      const res = await postUpdate(messageUpdate(ALICE, "/start"), secret);
      expect(res.status).toBe(401);
    }
    expect(tg.calls).toEqual([]);
    expect(await userExists(A)).toBe(false);
  });

  it("does not parse the body before checking the secret", async () => {
    const tg = mockTelegram();
    const res = await workerFetch("/tg/webhook", { method: "POST", body: "{not json" });
    expect(res.status).toBe(401);
    expect(tg.calls).toEqual([]);
  });

  it("unknown paths are 404", async () => {
    mockTelegram();
    expect((await workerFetch("/nope")).status).toBe(404);
    expect((await workerFetch("/tg/webhook")).status).toBe(404); // GET
    // /api/* is owned by the API app (auth runs first there).
    expect((await workerFetch("/api/nope")).status).toBe(401);
  });
});

describe("bot handlers via webhook", () => {
  it("/start greets, upserts the user and never calls getMe", async () => {
    const tg = mockTelegram();
    const res = await postUpdate(messageUpdate(ALICE, "/start"));
    expect(res.status).toBe(200);
    expect(tg.methods()).toEqual(["sendMessage"]);
    const [msg] = tg.sent();
    expect(msg!.payload).toMatchObject({ chat_id: A, text: GREETING_TEXT, parse_mode: "HTML" });
    expect(button(msg!)).toEqual({ text: "Открыть", web_app: { url: WEBAPP } });
    expect(await userExists(A)).toBe(true);
  });

  it("/start@botname works too", async () => {
    const tg = mockTelegram();
    await postUpdate(messageUpdate(ALICE, "/start@split_test_bot"));
    expect(tg.sent()[0]!.payload.text).toBe(GREETING_TEXT);
  });

  it("/start join_<code> joins, notifies other members, is idempotent", async () => {
    const { deps } = makeDeps();
    await s.upsertUser(deps, ALICE);
    const { event } = await s.createEvent(deps, A, "Дача <2025>", "RUB");
    const tg = mockTelegram();

    await postUpdate(messageUpdate(BOB, `/start join_${event.inviteCode}`));
    const sent = tg.sent();
    const reply = sent.find((c) => c.payload.chat_id === B)!;
    expect(reply.payload.text).toBe("Вы в событии «Дача &lt;2025&gt;»");
    expect(button(reply)).toEqual({ text: "Открыть событие", web_app: { url: `${WEBAPP}?event=${event.id}` } });
    // Alice is notified through waitUntil with an "Открыть событие" button.
    const note = sent.find((c) => c.payload.chat_id === A)!;
    expect(note.payload.text).toContain("присоединился");
    expect(note.payload.parse_mode).toBe("HTML");
    expect(button(note).web_app.url).toBe(`${WEBAPP}?event=${event.id}`);
    expect(await s.isMember(deps, event.id, B)).toBe(true);

    const tg2 = mockTelegram();
    await postUpdate(messageUpdate(BOB, `/start join_${event.inviteCode}`));
    expect(tg2.sent().map((c) => c.payload.text)).toEqual(["Вы уже в событии «Дача &lt;2025&gt;»"]);
  });

  it("/start with an invalid invite code answers nicely", async () => {
    const tg = mockTelegram();
    await postUpdate(messageUpdate(BOB, "/start join_doesNotExist"));
    expect(tg.sent().map((c) => c.payload.text)).toEqual([INVITE_NOT_FOUND_TEXT]);
    await postUpdate(messageUpdate(BOB, "/start join_<bad>"));
    expect(tg.sent()[1]!.payload.text).toBe(INVITE_NOT_FOUND_TEXT);
  });

  it("/start with another payload just greets", async () => {
    const tg = mockTelegram();
    await postUpdate(messageUpdate(BOB, "/start hello"));
    expect(tg.sent()[0]!.payload.text).toBe(GREETING_TEXT);
  });

  it("/debts without debts", async () => {
    const tg = mockTelegram();
    await postUpdate(messageUpdate(CAROL, "/debts"));
    const [msg] = tg.sent();
    expect(msg!.payload.text).toBe("Долгов нет 🎉");
    expect(button(msg!).text).toBe("Открыть");
  });

  it("/debts lists debts with escaped names", async () => {
    const { deps } = makeDeps();
    for (const u of [ALICE, { id: B, first_name: "<Боб>" }]) await s.upsertUser(deps, u);
    const { event } = await s.createEvent(deps, A, "Поездка", "RUB");
    await s.joinByInviteCode(deps, B, event.inviteCode);
    await s.addExpense(deps, event.id, A, { amount: 300101, description: "Отель", payerId: A, participantIds: [A, B] });

    const tg = mockTelegram();
    await postUpdate(messageUpdate({ id: B, first_name: "<Боб>" }, "/debts"));
    const text: string = tg.sent()[0]!.payload.text;
    expect(text).toContain("<b>Ваши долги</b>");
    expect(text).toContain("<b>«Поездка»</b>");
    expect(text).toContain("Вы должны: Алиса Иванова — 1 500,50 ₽");

    const tg2 = mockTelegram();
    await postUpdate(messageUpdate(ALICE, "/debts"));
    expect(tg2.sent()[0]!.payload.text).toContain("Вам должен(-а): &lt;Боб&gt; — 1 500,50 ₽");
  });

  it("/help and any other text", async () => {
    const tg = mockTelegram();
    await postUpdate(messageUpdate(ALICE, "/help"));
    await postUpdate(messageUpdate(ALICE, "привет"));
    await postUpdate(messageUpdate(ALICE, "/unknown"));
    expect(tg.sent().map((c) => c.payload.text)).toEqual([HELP_TEXT, UNKNOWN_TEXT, UNKNOWN_TEXT]);
  });

  it("ignores group chats", async () => {
    const tg = mockTelegram();
    const res = await postUpdate(messageUpdate(ALICE, "/start", { id: -100123, type: "supergroup", title: "G" }));
    expect(res.status).toBe(200);
    expect(tg.calls).toEqual([]);
    expect(await userExists(A)).toBe(false);
  });

  it("handler errors are logged and the user gets the error text", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const tg = mockTelegram((_call, i) => (i === 0 ? tgError(500, "Internal Server Error") : undefined));
    const res = await postUpdate(messageUpdate(ALICE, "/help"));
    expect(res.status).toBe(200);
    expect(tg.sent().map((c) => c.payload.text)).toEqual([HELP_TEXT, ERROR_TEXT]);
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain(env.BOT_TOKEN);
  });

  it("a malformed update with a valid secret is a 400 and is not processed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const tg = mockTelegram();
    for (const body of ["{not json", "{}", "[]", '{"update_id":"x"}']) {
      const res = await workerFetch("/tg/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
        body,
      });
      expect(res.status).toBe(400);
    }
    expect(tg.calls).toEqual([]);
  });

  it("answers 200 at once and handles the update in waitUntil", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tg = mockTelegram(async () => {
      await gate;
      return undefined;
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://split-bot.example/tg/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET, "Content-Type": "application/json" },
        body: JSON.stringify(messageUpdate(ALICE, "/help")),
      }),
      env,
      ctx,
    );
    // The response is ready while the reply to Telegram is still pending.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    release();
    await waitOnExecutionContext(ctx);
    expect(tg.sent().map((c) => c.payload.text)).toEqual([HELP_TEXT]);
  });

  it("returns 503 (Telegram retries) when bot info cannot be loaded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const tg = mockTelegram(() => tgError(401, "Unauthorized"));
    const e = { ...env, BOT_USERNAME: undefined, BOT_TOKEN: "555:no-username-token" };
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://split-bot.example/tg/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
        body: JSON.stringify(messageUpdate(ALICE, "/start")),
      }),
      e,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503);
    expect(tg.methods()).toEqual(["getMe"]);
  });
});
