import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_SECRET, WEBHOOK_SECRET, mockTelegram, tgError, workerFetch } from "./bot.helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

function setup(auth?: string) {
  return workerFetch("/admin/setup", { method: "POST", headers: auth === undefined ? {} : { Authorization: auth } });
}

describe("POST /admin/setup", () => {
  it("requires the admin bearer token", async () => {
    const tg = mockTelegram();
    for (const auth of [undefined, "", "Bearer", "Bearer wrong", `Basic ${ADMIN_SECRET}`, `Bearer ${ADMIN_SECRET}x`]) {
      const res = await setup(auth);
      expect(res.status).toBe(401);
    }
    expect(tg.calls).toEqual([]);
  });

  it("is POST only", async () => {
    mockTelegram();
    const res = await workerFetch("/admin/setup", { headers: { Authorization: `Bearer ${ADMIN_SECRET}` } });
    expect(res.status).toBe(404);
  });

  it("sets webhook, commands and menu button; returns a summary without secrets", async () => {
    const tg = mockTelegram();
    const res = await setup(`Bearer ${ADMIN_SECRET}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const secret of [ADMIN_SECRET, WEBHOOK_SECRET, env.BOT_TOKEN]) expect(text).not.toContain(secret);
    const json = JSON.parse(text);
    expect(json).toMatchObject({
      ok: true,
      bot_username: "split_test_bot",
      webhook_url: "https://split-bot.example/tg/webhook",
      allowed_updates: ["message"],
      commands: ["/start", "/debts", "/help"],
      menu_button: { text: "Открыть", url: env.WEBAPP_URL },
      warnings: [],
    });

    expect(tg.methods()).toEqual(["getMe", "setWebhook", "setMyCommands", "setChatMenuButton"]);
    expect(tg.calls.every((c) => c.token === env.BOT_TOKEN)).toBe(true);
    const [, webhook, commands, menu] = tg.calls;
    expect(webhook!.payload).toEqual({
      url: "https://split-bot.example/tg/webhook",
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message"],
      drop_pending_updates: true,
    });
    expect(commands!.payload.commands.map((c: any) => c.command)).toEqual(["start", "debts", "help"]);
    expect(menu!.payload).toEqual({
      menu_button: { type: "web_app", text: "Открыть", web_app: { url: env.WEBAPP_URL } },
    });
  });

  it("reports which Telegram step failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockTelegram((call) =>
      call.method === "setWebhook" ? tgError(400, "Bad Request: bad webhook: HTTPS url must be provided") : undefined,
    );
    const res = await setup(`Bearer ${ADMIN_SECRET}`);
    expect(res.status).toBe(502);
    const json = await res.json<any>();
    expect(json).toMatchObject({ ok: false, step: "setWebhook" });
    expect(json.detail).toContain("HTTPS");
    expect(JSON.stringify(json)).not.toContain(env.BOT_TOKEN);
  });
});
