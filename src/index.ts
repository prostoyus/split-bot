/**
 * Worker entry point.
 *   fetch:     /api/*         REST API for the Mini App (src/api)
 *              POST /tg/webhook   Telegram updates (grammY), secret header checked first
 *              POST /admin/setup  one-time Telegram setup (Bearer ADMIN_SECRET)
 *   scheduled: hourly debt reminders
 */

import { Hono, type Context } from "hono";
import { createApi } from "./api/app";
import { timingSafeEqualString } from "./api/auth";
import { createNotifier, noopNotifier, type Notifier } from "./core/notify";
import type { Deps } from "./core/services";
import type { Env } from "./env";
import { SECRET_HEADER, getBot, getBotUsername, handleWebhook } from "./bot/bot";
import { createTelegramSender, describeError } from "./bot/notifier";
import { runReminders } from "./bot/reminders";
import { SetupError, runSetup } from "./bot/setup";

type RootEnv = { Bindings: Env };

function executionCtx(c: Context<RootEnv>): ExecutionContext | undefined {
  try {
    return c.executionCtx as unknown as ExecutionContext;
  } catch {
    return undefined;
  }
}

function telegramNotifier(env: Env, ctx: ExecutionContext | undefined): Notifier {
  if (!ctx) return noopNotifier;
  return createNotifier(ctx.waitUntil.bind(ctx), createTelegramSender(getBot(env).api, env.WEBAPP_URL));
}

/** Per-request dependencies shared by the API and the bot. */
export async function makeDeps(env: Env, ctx: ExecutionContext | undefined): Promise<Deps> {
  return { db: env.DB, notify: telegramNotifier(env, ctx), botUsername: await getBotUsername(env) };
}

/** True only if a secret is configured and `given` equals it (constant time). */
function secretMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!expected) return false;
  return timingSafeEqualString(given ?? "", expected);
}

export function createApp(): Hono<RootEnv> {
  const app = new Hono<RootEnv>();

  app.onError((err, c) => {
    console.error("unhandled error", c.req.method, c.req.path, describeError(err, c.env?.BOT_TOKEN));
    return c.json({ detail: "Внутренняя ошибка сервера" }, 500);
  });

  app.post("/tg/webhook", async (c) => {
    // Reject before touching the body or the bot.
    if (!secretMatches(c.req.header(SECRET_HEADER), c.env.WEBHOOK_SECRET)) {
      if (!c.env.WEBHOOK_SECRET) console.error("WEBHOOK_SECRET is not configured");
      return c.body(null, 401);
    }
    const ctx = executionCtx(c);
    const deps = await makeDeps(c.env, ctx);
    return handleWebhook(c, c.env, { deps, webappUrl: c.env.WEBAPP_URL }, ctx);
  });

  app.post("/admin/setup", async (c) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
    if (!secretMatches(token, c.env.ADMIN_SECRET)) return c.json({ detail: "Unauthorized" }, 401);
    if (!c.env.WEBHOOK_SECRET || !c.env.BOT_TOKEN) {
      return c.json({ ok: false, detail: "BOT_TOKEN and WEBHOOK_SECRET must be configured" }, 500);
    }
    const origin = new URL(c.req.url).origin;
    if (!origin.startsWith("https://")) {
      return c.json({ ok: false, detail: `Telegram requires an https webhook URL, got ${origin}` }, 400);
    }
    const bot = getBot(c.env);
    try {
      const summary = await runSetup(
        bot.api,
        { origin, webhookSecret: c.env.WEBHOOK_SECRET, webappUrl: c.env.WEBAPP_URL },
        (me) => {
          bot.botInfo = me; // real info replaces a synthetic one
        },
      );
      const envName = c.env.BOT_USERNAME?.trim().replace(/^@/, "");
      const warnings =
        envName && envName.toLowerCase() !== summary.bot_username.toLowerCase()
          ? [`BOT_USERNAME (${envName}) differs from the real bot username (${summary.bot_username})`]
          : [];
      return c.json({ ...summary, warnings });
    } catch (err) {
      if (err instanceof SetupError) {
        console.error("admin setup failed", err.step, err.detail);
        return c.json({ ok: false, step: err.step, detail: err.detail }, 502);
      }
      throw err;
    }
  });

  app.route("/", createApi({ deps: makeDeps }));

  app.notFound((c) => c.json({ detail: "Не найдено" }, 404));
  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(controller, env, _ctx) {
    try {
      const deps: Deps = { db: env.DB, notify: noopNotifier, botUsername: env.BOT_USERNAME };
      await runReminders(env, deps, controller.scheduledTime);
    } catch (err) {
      console.error("scheduled reminders failed", describeError(err, env.BOT_TOKEN));
    }
  },
} satisfies ExportedHandler<Env>;
