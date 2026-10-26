import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Api } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { botInfoFromUsername, ensureBotInfo, getBot, getBotUsername } from "../src/bot/bot";
import { buildWebappUrl, openAppKeyboard, openEventKeyboard } from "../src/bot/keyboards";
import { createTelegramSender, describeError } from "../src/bot/notifier";
import {
  NO_DEBTS_TEXT,
  formatDebtsSummary,
  formatTotals,
  joinedText,
  parseJoinPayload,
  reminderText,
  splitMessage,
} from "../src/bot/texts";
import { createNotifier } from "../src/core/notify";
import { FAKE_ME, mockTelegram, tgError } from "./bot.helpers";

const TOKEN = "123456:TEST-token-for-vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("keyboards", () => {
  it("builds Mini App URLs and keeps query and fragment", () => {
    const base = "https://prostoyus.github.io/split-bot/webapp/";
    expect(buildWebappUrl(base)).toBe(base);
    expect(buildWebappUrl(` ${base} `, 42)).toBe(`${base}?event=42`);
    expect(buildWebappUrl("https://x.io/app?theme=dark", 7)).toBe("https://x.io/app?theme=dark&event=7");
    expect(buildWebappUrl("https://x.io/app?", 7)).toBe("https://x.io/app?event=7");
    expect(buildWebappUrl("https://x.io/app#top", 7)).toBe("https://x.io/app?event=7#top");
    expect(buildWebappUrl("https://x.io/app?a=1#/route?b=2", 7)).toBe("https://x.io/app?a=1&event=7#/route?b=2");
    expect(buildWebappUrl(base, null)).toBe(base);
    expect(buildWebappUrl(base)).not.toContain("api=");
    expect(() => buildWebappUrl("")).toThrow();
    expect(() => buildWebappUrl(base, 0)).toThrow();
    expect(() => buildWebappUrl(base, 1.5)).toThrow();
  });

  it("keyboards use web_app buttons", () => {
    const base = "https://x.io/app";
    expect(openAppKeyboard(base).inline_keyboard).toEqual([[{ text: "Открыть", web_app: { url: base } }]]);
    expect(openEventKeyboard(base, 5).inline_keyboard).toEqual([
      [{ text: "Открыть событие", web_app: { url: `${base}?event=5` } }],
    ]);
    expect(openEventKeyboard(base).inline_keyboard[0]![0]!.text).toBe("Открыть");
  });
});

describe("texts", () => {
  const bob = { id: 2, name: "Боб", username: null };
  const eve = { id: 3, name: "<Ева>", username: null };

  it("debts summary", () => {
    expect(formatDebtsSummary([])).toBe(NO_DEBTS_TEXT);
    const text = formatDebtsSummary([
      { eventId: 1, title: "Поездка <в> Казань", currency: "RUB", net: -150050, owes: [{ toUser: bob, amount: 150050 }], owedBy: [] },
      { eventId: 2, title: "Квартира", currency: "USD", net: 1000, owes: [], owedBy: [{ fromUser: eve, amount: 1000 }] },
      { eventId: 3, title: "Ноль", currency: "RUB", net: 5, owes: [], owedBy: [] },
    ]);
    expect(text).toContain("«Поездка &lt;в&gt; Казань»");
    expect(text).toContain("Вы должны: Боб — 1 500,50 ₽");
    expect(text).toContain("&lt;Ева&gt; — 10 $");
    expect(text).toContain("Ваш баланс:");
    expect(text).not.toContain("<Ева>");
  });

  it("split message", () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} ` + "x".repeat(50)).join("\n");
    const chunks = splitMessage(text, 1000);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunks.join("\n")).toBe(text);
    expect(splitMessage("a".repeat(2500), 1000).map((c) => c.length)).toEqual([1000, 1000, 500]);
    expect(splitMessage("hi")).toEqual(["hi"]);
    const big = Array.from({ length: 200 }, (_, i) => `строка ${i} ` + "я".repeat(40)).join("\n");
    expect(splitMessage(big).every((c) => c.length <= 4096)).toBe(true);
  });

  it("join payload, joined text, reminder text", () => {
    expect(parseJoinPayload("join_abc")).toBe("join_abc");
    expect(parseJoinPayload(" join_abc ")).toBe("join_abc");
    expect(parseJoinPayload("hello")).toBeNull();
    expect(parseJoinPayload("")).toBeNull();
    expect(parseJoinPayload(undefined)).toBeNull();
    expect(joinedText("A&B", true)).toBe("Вы в событии «A&amp;B»");
    expect(joinedText("A&B", false)).toBe("Вы уже в событии «A&amp;B»");
    expect(reminderText({ eventTitle: "A&B", currency: "RUB", amount: 50000 })).toBe(
      "Напоминание: вы должны 500 ₽ в «A&amp;B»",
    );
  });
});

describe("totals (Итого)", () => {
  const bob = { id: 2, name: "Боб", username: null };
  const item = (eventId: number, currency: string, net: number) => ({
    eventId,
    title: `E${eventId}`,
    currency,
    net,
    owes: net < 0 ? [{ toUser: bob, amount: -net }] : [],
    owedBy: net > 0 ? [{ fromUser: bob, amount: net }] : [],
  });

  it("single currency, mixed", () => {
    expect(formatTotals([item(1, "RUB", -150050), item(2, "RUB", 50000), item(3, "RUB", -10000)])).toBe(
      "<b>Итого</b>\nВы должны: 1 600,50 ₽\nВам должны: 500 ₽\nВ итоге: вы должны 1 100,50 ₽",
    );
    expect(formatTotals([item(1, "RUB", -5000), item(2, "RUB", 5000)])).toBe(
      "<b>Итого</b>\nВы должны: 50 ₽\nВам должны: 50 ₽\nВсё ровно",
    );
  });

  it("several currencies are never converted and are labelled", () => {
    expect(formatTotals([item(1, "RUB", -10000), item(2, "USD", 2500), item(3, "RUB", 30000)])).toBe(
      [
        "<b>Итого</b>",
        "<i>RUB</i>",
        "Вы должны: 100 ₽",
        "Вам должны: 300 ₽",
        "В итоге: вам должны 200 ₽",
        "<i>USD</i>",
        "Вам должны: 25 $",
        "В итоге: вам должны 25 $",
      ].join("\n"),
    );
  });

  it("owe-only and owed-only omit the zero line", () => {
    expect(formatTotals([item(1, "RUB", -10000)])).toBe("<b>Итого</b>\nВы должны: 100 ₽\nВ итоге: вы должны 100 ₽");
    expect(formatTotals([item(1, "RUB", 10000)])).toBe("<b>Итого</b>\nВам должны: 100 ₽\nВ итоге: вам должны 100 ₽");
  });

  it("all zero → no totals, «Долгов нет 🎉»", () => {
    expect(formatTotals([])).toBeNull();
    expect(formatTotals([item(1, "RUB", 0)])).toBeNull();
    expect(formatDebtsSummary([])).toBe(NO_DEBTS_TEXT);
    expect(formatDebtsSummary([item(1, "RUB", 0)])).toBe(NO_DEBTS_TEXT);
  });

  it("totals come first, then the per-event details; long lists still split", () => {
    const text = formatDebtsSummary([item(1, "RUB", -10000), item(2, "RUB", 2500)]);
    expect(text.startsWith("<b>Итого</b>\nВы должны: 100 ₽")).toBe(true);
    expect(text.indexOf("<b>Итого</b>")).toBeLessThan(text.indexOf("<b>Ваши долги</b>"));
    expect(text).toContain("<b>«E1»</b>\nВы должны: Боб — 100 ₽");
    const many = Array.from({ length: 300 }, (_, i) => item(i + 1, i % 2 ? "RUB" : "USD", (i % 7) - 3 || 1));
    const chunks = splitMessage(formatDebtsSummary(many));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 4096)).toBe(true);
    // Currencies follow the fixed CURRENCIES order (same as the Mini App), not event order.
    expect(chunks[0]!.startsWith("<b>Итого</b>\n<i>RUB</i>")).toBe(true);
  });
});

describe("telegram sender / notifier", () => {
  const api = () => new Api(TOKEN);

  it("sends HTML with an event button only when eventId is given", async () => {
    const tg = mockTelegram();
    const send = createTelegramSender(api(), "https://x.io/app");
    expect(await send(7, "<b>hi</b>", { eventId: 3 })).toBe("sent");
    expect(await send(7, "plain")).toBe("sent");
    const [a, b] = tg.sent();
    expect(a!.payload).toMatchObject({ chat_id: 7, text: "<b>hi</b>", parse_mode: "HTML" });
    expect(a!.payload.reply_markup.inline_keyboard[0][0]).toEqual({
      text: "Открыть событие",
      web_app: { url: "https://x.io/app?event=3" },
    });
    expect(b!.payload.reply_markup).toBeUndefined();
  });

  it("swallows blocked / chat not found, reports 429 without sleeping, throws on the rest", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockTelegram((call) => {
      switch (call.payload.chat_id) {
        case 1:
          return tgError(403, "Forbidden: bot was blocked by the user");
        case 2:
          return tgError(400, "Bad Request: chat not found");
        case 3:
          return tgError(429, "Too Many Requests: retry after 30", { parameters: { retry_after: 30 } });
        case 4:
          return tgError(400, "Bad Request: can't parse entities");
        case 5:
          throw new TypeError("network down");
        default:
          return undefined;
      }
    });
    const send = createTelegramSender(api(), "https://x.io/app");
    expect(await send(1, "x")).toBe("unreachable");
    expect(await send(2, "x")).toBe("unreachable");
    const t0 = Date.now();
    expect(await send(3, "x")).toBe("rate_limited");
    expect(Date.now() - t0).toBeLessThan(2000);
    await expect(send(4, "x")).rejects.toThrow(/parse entities/);
    await expect(send(5, "x")).rejects.toThrow();
  });

  it("createNotifier + sender never throws and runs in waitUntil", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const tg = mockTelegram((call) => (call.payload.chat_id === 1 ? tgError(500, "Internal") : undefined));
    const ctx = createExecutionContext();
    const notify = createNotifier(ctx.waitUntil.bind(ctx), createTelegramSender(api(), "https://x.io/app"));
    expect(() => notify(1, "a", { eventId: 1 })).not.toThrow();
    expect(() => notify(2, "b")).not.toThrow();
    await waitOnExecutionContext(ctx);
    expect(tg.sent().length).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("describeError redacts the token", () => {
    expect(describeError(new Error(`boom ${TOKEN} boom`), TOKEN)).toBe("Error: boom *** boom");
  });
});

describe("bot instance", () => {
  it("builds botInfo from BOT_USERNAME without getMe", async () => {
    const info = botInfoFromUsername(TOKEN, "@split_test_bot");
    expect(info).toMatchObject({ id: 123456, is_bot: true, username: "split_test_bot" });
    const tg = mockTelegram();
    expect((await ensureBotInfo(env)).username).toBe("split_test_bot");
    expect(await getBotUsername(env)).toBe("split_test_bot");
    expect(tg.calls).toEqual([]);
    expect(getBot(env)).toBe(getBot(env)); // memoized
  });

  it("without BOT_USERNAME calls getMe once per isolate and memoizes it", async () => {
    const tg = mockTelegram();
    const e = { ...env, BOT_USERNAME: undefined, BOT_TOKEN: "777:other-token" };
    const [u1, u2] = await Promise.all([getBotUsername(e), getBotUsername(e)]);
    expect([u1, u2]).toEqual([FAKE_ME.username, FAKE_ME.username]);
    expect(await getBotUsername(e)).toBe(FAKE_ME.username);
    expect(tg.methods()).toEqual(["getMe"]);
    expect(getBot(e).isInited()).toBe(true);
  });

  it("a failing getMe is not retried on every request", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const tg = mockTelegram(() => tgError(401, "Unauthorized"));
    const e = { ...env, BOT_USERNAME: undefined, BOT_TOKEN: "888:bad-token" };
    expect(await getBotUsername(e)).toBeUndefined();
    expect(await getBotUsername(e)).toBeUndefined();
    expect(tg.methods()).toEqual(["getMe"]);
  });
});
