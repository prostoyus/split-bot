import { env } from "cloudflare:workers";
import { createApi, type ApiOptions } from "../src/api/app";
import type { NotifyExtra } from "../src/core/notify";
import * as s from "../src/core/services";

/** Must match the BOT_TOKEN binding in vitest.config.ts. */
export const TEST_BOT_TOKEN = "123456:TEST-token-for-vitest";

export const ALICE = { id: 1001, first_name: "Алиса", last_name: "Иванова", username: "alice" };
export const BOB = { id: 1002, first_name: "Боб", username: "bob" };
export const CAROL = { id: 1003, first_name: "Кэрол" };
export const MALLORY = { id: 6666, first_name: "Mallory" };
export const A = ALICE.id;
export const B = BOB.id;
export const C = CAROL.id;
export const M = MALLORY.id;

export interface SentMessage {
  userId: number;
  html: string;
  extra?: NotifyExtra;
}

/** Fake Notifier that records calls. */
export function fakeNotifier() {
  const sent: SentMessage[] = [];
  const notify = (userId: number, html: string, extra?: NotifyExtra) => {
    sent.push({ userId, html, extra });
  };
  return { sent, notify };
}

export function makeDeps() {
  const { sent, notify } = fakeNotifier();
  const deps: s.Deps = { db: env.DB, notify, botUsername: "split_test_bot" };
  return { deps, sent };
}

export async function seedUsers(deps: s.Deps): Promise<void> {
  for (const u of [ALICE, BOB, CAROL, MALLORY]) await s.upsertUser(deps, u);
}

/** Alice creates "Поездка"; Bob and Carol join. */
export async function eventWithThree(deps: s.Deps) {
  await seedUsers(deps);
  const { event } = await s.createEvent(deps, A, "Поездка", "RUB");
  for (const uid of [B, C]) await s.joinByInviteCode(deps, uid, event.inviteCode);
  return event;
}

const enc = new TextEncoder();

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build initData signed exactly like Telegram does. */
export async function makeInitData(
  user: object,
  opts: { authDate?: number; token?: string } = {},
): Promise<string> {
  const fields: Record<string, string> = {
    auth_date: String(opts.authDate ?? Math.floor(Date.now() / 1000)),
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: JSON.stringify(user),
  };
  const check = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = await hmac(enc.encode("WebAppData"), opts.token ?? TEST_BOT_TOKEN);
  fields.hash = hex(await hmac(secret, check));
  return new URLSearchParams(fields).toString();
}

export async function authHeaders(user: object): Promise<Record<string, string>> {
  return { "X-Telegram-Init-Data": await makeInitData(user) };
}

/** API test client calling the Hono app directly with a fake notifier. */
export function apiClient(options: ApiOptions = {}) {
  const { sent, notify } = fakeNotifier();
  const app = createApi({
    deps: (e) => ({ db: e.DB, notify, botUsername: "split_test_bot" }),
    ...options,
  });
  async function call(
    method: string,
    path: string,
    user?: object,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const h: Record<string, string> = { ...headers };
    if (user) Object.assign(h, await authHeaders(user));
    if (body !== undefined) h["Content-Type"] = "application/json";
    const res = await app.request(
      path,
      { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) },
      env,
    );
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  }
  return { app, sent, call };
}
