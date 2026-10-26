/** Test helpers for the bot layer: a fake Telegram Bot API (global fetch stub) and update builders. */

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import worker from "../src/index";

export const WEBHOOK_SECRET = "test-webhook-secret-0123456789abcdef";
export const ADMIN_SECRET = "test-admin-secret-0123456789abcdef";
export const ORIGIN = "https://split-bot.example";

export interface TgCall {
  token: string;
  method: string;
  payload: any;
}

/** Return a Response (or a plain object = `result`) to override; undefined = default answer. */
export type TgHandler = (call: TgCall, index: number) => Response | object | undefined | Promise<Response | object | undefined>;

export function tgError(code: number, description: string, extra: object = {}): Response {
  return new Response(JSON.stringify({ ok: false, error_code: code, description, ...extra }), {
    status: code,
    headers: { "Content-Type": "application/json" },
  });
}

export const FAKE_ME = {
  id: 123456,
  is_bot: true,
  first_name: "Split",
  username: "split_test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

function defaultResult(call: TgCall): unknown {
  switch (call.method) {
    case "getMe":
      return FAKE_ME;
    case "sendMessage":
      return {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: call.payload.chat_id, type: "private", first_name: "X" },
        text: call.payload.text,
      };
    default:
      return true;
  }
}

/**
 * Stub global fetch: requests to api.telegram.org are answered locally and recorded; any other
 * outgoing request fails the test. Nothing ever reaches the network.
 */
export function mockTelegram(handler?: TgHandler) {
  const calls: TgCall[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
    if (!m) throw new Error(`unexpected fetch in test: ${url}`);
    const body = init?.body;
    const payload = typeof body === "string" && body ? JSON.parse(body) : {};
    const call: TgCall = { token: m[1]!, method: m[2]!, payload };
    const index = calls.length;
    calls.push(call);
    const custom = handler ? await handler(call, index) : undefined;
    if (custom instanceof Response) return custom;
    const result = custom !== undefined ? custom : defaultResult(call);
    return new Response(JSON.stringify({ ok: true, result }), { headers: { "Content-Type": "application/json" } });
  });
  return {
    calls,
    spy,
    sent: () => calls.filter((c) => c.method === "sendMessage"),
    methods: () => calls.map((c) => c.method),
  };
}

let nextUpdateId = 1000;
let nextMessageId = 1;

export interface TgUserLike {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export function messageUpdate(from: TgUserLike, text: string, chat?: { id: number; type: string; title?: string }) {
  const command = /^\/\S+/.exec(text);
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: chat ?? { id: from.id, type: "private", first_name: from.first_name },
      from: { ...from, is_bot: false },
      text,
      ...(command ? { entities: [{ type: "bot_command", offset: 0, length: command[0].length }] } : {}),
    },
  };
}

/** POST an update to /tg/webhook through the Worker entry and wait for waitUntil tasks. */
export async function postUpdate(update: unknown, secret: string | null = WEBHOOK_SECRET): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${ORIGIN}/tg/webhook`, { method: "POST", headers, body: JSON.stringify(update) }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

export async function workerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
