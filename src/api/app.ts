/**
 * REST API for the Mini App (Hono), routes under /api. See SPEC.md "REST API".
 *
 * Usage (index.ts): `root.route("/", createApi({ deps }))` or `createApi(...).fetch(req, env, ctx)`.
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { toIso } from "../core/db";
import { ServiceError, TooManyRequestsError, UnauthorizedError, ValidationError } from "../core/errors";
import { noopNotifier } from "../core/notify";
import * as services from "../core/services";
import type { Deps, EventDetail, ExpenseView, SettlementView, UserRef } from "../core/services";
import type { Env } from "../env";
import { InitDataError, validateInitData } from "./auth";

export interface ApiOptions {
  /**
   * Per-request dependencies. Default: `{ db: env.DB, notify: noop, botUsername: env.BOT_USERNAME }`.
   * `ctx` is undefined when the app is called without an ExecutionContext (some tests).
   */
  deps?: (env: Env, ctx: ExecutionContext | undefined) => Deps | Promise<Deps>;
  /** Requests per user per minute (best-effort, per isolate). Default 120. */
  rateLimitPerMinute?: number;
}

type AppEnv = { Bindings: Env; Variables: { user: UserRef; deps: Deps } };

const MAX_ID = 2 ** 53;
const MAX_BODY_BYTES = 64 * 1024;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const INTERNAL_ERROR = "Внутренняя ошибка сервера";

// ---------------------------------------------------------------- CORS

function allowedOrigins(env: Env): Set<string> {
  return new Set(
    (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
}

export function isAllowedOrigin(origin: string, env: Env): boolean {
  return LOCAL_ORIGIN.test(origin) || allowedOrigins(env).has(origin);
}

const cors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header("Origin");
  const allowed = origin !== undefined && isAllowedOrigin(origin, c.env);
  if (c.req.method === "OPTIONS" && c.req.header("Access-Control-Request-Method")) {
    const headers = new Headers({ Vary: "Origin" });
    if (allowed) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "X-Telegram-Init-Data, Content-Type");
      headers.set("Access-Control-Max-Age", "600");
    }
    return new Response(null, { status: 204, headers });
  }
  await next();
  // Runs for error responses too (onError has already produced c.res).
  try {
    c.res.headers.append("Vary", "Origin");
    if (allowed) c.res.headers.set("Access-Control-Allow-Origin", origin);
  } catch {
    // Immutable headers (e.g. a passed-through fetch response): rebuild the response.
    const res = new Response(c.res.body, c.res);
    res.headers.append("Vary", "Origin");
    if (allowed) res.headers.set("Access-Control-Allow-Origin", origin);
    c.res = res;
  }
};

// ---------------------------------------------------------------- rate limiting

/** Fixed one-minute window per user, per isolate. Best effort only. */
class RateLimiter {
  private windowStart = 0;
  private counts = new Map<number, number>();

  constructor(private readonly limit: number) {}

  allow(key: number, now = Date.now()): boolean {
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.counts.clear();
    }
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n <= this.limit;
  }
}

// ---------------------------------------------------------------- validation

const FIELD_ERRORS: Record<string, string> = {
  title: "Некорректное название события",
  currency: "Некорректная валюта",
  invite_code: "Некорректный код приглашения",
  amount: "Сумма должна быть целым числом в копейках",
  description: "Некорректное описание",
  payer_id: "Некорректный плательщик",
  participant_ids: "Некорректный список участников",
  split: "Некорректный способ деления: допустимо «equal» или «exact»",
  shares: "Некорректный список долей",
  to_id: "Некорректный получатель",
  event_id: "Некорректный номер события",
  expense_id: "Некорректный номер траты",
  settlement_id: "Некорректный номер перевода",
};

function invalid(field: string): never {
  throw new ValidationError(FIELD_ERRORS[field] ?? "Некорректные данные запроса");
}

type Body = Record<string, unknown>;

const tooLarge = () => new ServiceError(413, "Слишком большой запрос");

/**
 * Read the body as UTF-8 text, at most `maxBytes` BYTES. A declared Content-Length is checked up
 * front, but never trusted: the stream itself is counted and aborted as soon as it exceeds the cap.
 */
export async function readTextCapped(req: Request, maxBytes: number): Promise<string> {
  const declared = req.headers.get("Content-Length");
  if (declared !== null && Number(declared) > maxBytes) throw tooLarge();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ValidationError("Некорректные данные запроса");
  }
}

async function readBody(c: Context<AppEnv>): Promise<Body> {
  const text = await readTextCapped(c.req.raw, MAX_BODY_BYTES);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ValidationError("Некорректные данные запроса");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ValidationError("Некорректные данные запроса");
  }
  return data as Body;
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

function isId(v: unknown): v is number {
  return isInt(v) && v >= 1 && v <= MAX_ID;
}

function str(body: Body, field: string, maxLen: number): string {
  const v = body[field];
  if (typeof v !== "string" || v.length > maxLen) invalid(field);
  return v;
}

function optStr(body: Body, field: string, maxLen: number): string | null | undefined {
  const v = body[field];
  if (v === undefined || v === null) return v;
  if (typeof v !== "string" || v.length > maxLen) invalid(field);
  return v;
}

function int(body: Body, field: string): number {
  const v = body[field];
  if (!isInt(v)) invalid(field);
  return v;
}

function id(body: Body, field: string): number {
  const v = body[field];
  if (!isId(v)) invalid(field);
  return v;
}

function pathId(c: Context<AppEnv>, param: string): number {
  const raw = c.req.param(param) ?? "";
  const n = /^\d{1,16}$/.test(raw) ? Number(raw) : NaN;
  if (!isId(n)) invalid(param);
  return n;
}

function parseExpenseBody(body: Body): services.AddExpenseInput {
  const amount = int(body, "amount");
  const description = str(body, "description", 1000);
  const payerId = id(body, "payer_id");
  const split = body.split;
  if (split !== undefined && split !== null && split !== "equal" && split !== "exact") invalid("split");

  let participantIds: number[] | null | undefined;
  const p = body.participant_ids;
  if (p !== undefined && p !== null) {
    if (!Array.isArray(p) || p.length > services.MAX_PARTICIPANTS || !p.every(isId)) invalid("participant_ids");
    participantIds = p;
  } else {
    participantIds = p;
  }

  let shares: services.ShareInput[] | null | undefined;
  const s = body.shares;
  if (s !== undefined && s !== null) {
    if (!Array.isArray(s) || s.length > services.MAX_PARTICIPANTS) invalid("shares");
    shares = s.map((item: unknown) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) invalid("shares");
      const it = item as Body;
      if (!isId(it.user_id) || !isInt(it.amount)) invalid("shares");
      return { userId: it.user_id, amount: it.amount };
    });
  } else {
    shares = s;
  }
  return { amount, description, payerId, split: split ?? "equal", participantIds, shares };
}

// ---------------------------------------------------------------- serializers

function inviteLink(deps: Deps, code: string): string | null {
  const name = (deps.botUsername ?? "").replace(/^@/, "");
  return name ? `https://t.me/${name}?start=join_${code}` : null;
}

function eventDetailOut(deps: Deps, d: EventDetail) {
  return {
    id: d.event.id,
    title: d.event.title,
    currency: d.event.currency,
    invite_code: d.event.inviteCode,
    invite_link: inviteLink(deps, d.event.inviteCode),
    owner_id: d.event.ownerId,
    members: d.members,
    my_net: d.myNet,
  };
}

function expenseOut(x: ExpenseView) {
  return {
    id: x.id,
    payer: x.payer,
    amount: x.amount,
    description: x.description,
    split: x.split,
    created_at: toIso(x.createdAt),
    created_by: x.createdBy,
    shares: x.shares.map((s) => ({ user: s.user, amount: s.amount })),
  };
}

function settlementOut(s: SettlementView) {
  return {
    id: s.id,
    from: s.from,
    to: s.to,
    amount: s.amount,
    status: s.status,
    created_at: toIso(s.createdAt),
  };
}

// ---------------------------------------------------------------- app

function executionCtx(c: Context<AppEnv>): ExecutionContext | undefined {
  try {
    return c.executionCtx as unknown as ExecutionContext;
  } catch {
    return undefined;
  }
}

export function createApi(options: ApiOptions = {}): Hono<AppEnv> {
  const makeDeps =
    options.deps ??
    ((env: Env): Deps => ({ db: env.DB, notify: noopNotifier, botUsername: env.BOT_USERNAME }));
  const limiter = new RateLimiter(options.rateLimitPerMinute ?? 120);
  const app = new Hono<AppEnv>().basePath("/api");

  app.onError((err, c) => {
    if (err instanceof ServiceError) return c.json({ detail: err.message }, err.status as 400);
    console.error("Unhandled API error", c.req.method, c.req.path, err instanceof Error ? err.stack : err);
    return c.json({ detail: INTERNAL_ERROR }, 500);
  });

  app.use("*", cors);

  app.get("/health", (c) => c.json({ ok: true }));

  // Auth: every other /api route requires valid initData; the user is upserted.
  app.use("*", async (c, next) => {
    const initData = c.req.header("X-Telegram-Init-Data");
    if (!initData) {
      throw new UnauthorizedError("Нет данных авторизации. Откройте приложение через Telegram-бота.");
    }
    let tgUser;
    try {
      tgUser = await validateInitData(initData, c.env.BOT_TOKEN);
    } catch (err) {
      if (!(err instanceof InitDataError)) throw err;
      throw new UnauthorizedError(
        err.expired
          ? "Сессия устарела. Откройте приложение заново через бота."
          : "Не удалось проверить данные Telegram. Откройте приложение через бота.",
      );
    }
    if (!limiter.allow(tgUser.id)) throw new TooManyRequestsError();
    const deps = await makeDeps(c.env, executionCtx(c));
    c.set("deps", deps);
    c.set("user", await services.upsertUser(deps, tgUser));
    await next();
  });

  app.get("/config", (c) => c.json({ bot_username: (c.var.deps.botUsername ?? "").replace(/^@/, "") }));

  app.get("/me", (c) => c.json(c.var.user));

  app.get("/events", async (c) => {
    const items = await services.listUserEvents(c.var.deps, c.var.user.id);
    return c.json(
      items.map((e) => ({
        id: e.id,
        title: e.title,
        currency: e.currency,
        members_count: e.membersCount,
        my_net: e.myNet,
      })),
    );
  });

  app.post("/events", async (c) => {
    const body = await readBody(c);
    const title = str(body, "title", 500);
    const currency = optStr(body, "currency", 10);
    const detail = await services.createEvent(c.var.deps, c.var.user.id, title, currency ?? "RUB");
    return c.json(eventDetailOut(c.var.deps, detail));
  });

  app.get("/events/:event_id", async (c) => {
    const detail = await services.getEventDetail(c.var.deps, pathId(c, "event_id"), c.var.user.id);
    return c.json(eventDetailOut(c.var.deps, detail));
  });

  app.post("/join", async (c) => {
    const body = await readBody(c);
    const code = str(body, "invite_code", 64);
    const { detail } = await services.joinByInviteCode(c.var.deps, c.var.user.id, code);
    return c.json(eventDetailOut(c.var.deps, detail));
  });

  app.get("/events/:event_id/expenses", async (c) => {
    const items = await services.listExpenses(c.var.deps, pathId(c, "event_id"), c.var.user.id);
    return c.json(items.map(expenseOut));
  });

  app.post("/events/:event_id/expenses", async (c) => {
    const eventId = pathId(c, "event_id");
    const input = parseExpenseBody(await readBody(c));
    const view = await services.addExpense(c.var.deps, eventId, c.var.user.id, input);
    return c.json(expenseOut(view));
  });

  app.delete("/expenses/:expense_id", async (c) => {
    await services.deleteExpense(c.var.deps, pathId(c, "expense_id"), c.var.user.id);
    return c.json({ ok: true });
  });

  app.get("/events/:event_id/balances", async (c) => {
    const result = await services.getEventBalances(c.var.deps, pathId(c, "event_id"), c.var.user.id);
    return c.json({
      balances: result.balances.map((b) => ({ user: b.user, net: b.net })),
      transfers: result.transfers.map((t) => ({ from: t.from, to: t.to, amount: t.amount })),
    });
  });

  app.get("/events/:event_id/settlements", async (c) => {
    const items = await services.listSettlements(c.var.deps, pathId(c, "event_id"), c.var.user.id);
    return c.json(items.map(settlementOut));
  });

  app.post("/events/:event_id/settlements", async (c) => {
    const eventId = pathId(c, "event_id");
    const body = await readBody(c);
    const toId = id(body, "to_id");
    const amount = int(body, "amount");
    const view = await services.createSettlement(c.var.deps, eventId, c.var.user.id, toId, amount);
    return c.json(settlementOut(view));
  });

  app.post("/settlements/:settlement_id/confirm", async (c) => {
    const view = await services.confirmSettlement(c.var.deps, pathId(c, "settlement_id"), c.var.user.id);
    return c.json(settlementOut(view));
  });

  app.post("/settlements/:settlement_id/reject", async (c) => {
    const view = await services.rejectSettlement(c.var.deps, pathId(c, "settlement_id"), c.var.user.id);
    return c.json(settlementOut(view));
  });

  // Unknown /api paths (a real route, so it also works when this app is mounted into another one).
  app.all("*", (c) => c.json({ detail: "Не найдено" }, 404));

  return app;
}
