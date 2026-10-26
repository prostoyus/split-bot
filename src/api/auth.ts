/**
 * Telegram Mini App initData validation (WebCrypto).
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * secret = HMAC_SHA256(key = "WebAppData", msg = BOT_TOKEN)
 * hash   = hex(HMAC_SHA256(key = secret, msg = data_check_string))
 * data_check_string = sorted "key=value" lines (all fields except `hash`) joined by "\n".
 */

export const MAX_AGE_SECONDS = 24 * 60 * 60;
export const MAX_FUTURE_SKEW_SECONDS = 5 * 60;
export const MAX_INIT_DATA_LENGTH = 8192;
const MAX_TELEGRAM_ID = 2 ** 53;

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
}

export class InitDataError extends Error {
  readonly expired: boolean;

  constructor(message: string, expired = false) {
    super(message);
    this.name = "InitDataError";
    this.expired = expired;
  }
}

const encoder = new TextEncoder();

// Per-isolate cache: the derived HMAC key depends only on the bot token.
let cachedToken: string | null = null;
let cachedKey: Promise<CryptoKey> | null = null;

async function deriveKey(botToken: string): Promise<CryptoKey> {
  const webAppDataKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const secret = await crypto.subtle.sign("HMAC", webAppDataKey, encoder.encode(botToken));
  return crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function dataKey(botToken: string): Promise<CryptoKey> {
  if (cachedToken !== botToken || !cachedKey) {
    cachedToken = botToken;
    cachedKey = deriveKey(botToken);
    cachedKey.catch(() => {
      cachedToken = null;
      cachedKey = null;
    });
  }
  return cachedKey;
}

function decodeComponent(raw: string): string {
  // application/x-www-form-urlencoded: "+" means space. Throws URIError on malformed escapes.
  return decodeURIComponent(raw.replace(/\+/g, " "));
}

/** Strict query-string parse: every part must be key=value; duplicate keys are rejected. */
export function parseInitData(initData: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of initData.split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) throw new InitDataError("init data is malformed");
    let key: string;
    let value: string;
    try {
      key = decodeComponent(part.slice(0, eq));
      value = decodeComponent(part.slice(eq + 1));
    } catch {
      throw new InitDataError("init data is malformed");
    }
    if (fields.has(key)) throw new InitDataError("duplicate field in init data");
    fields.set(key, value);
  }
  return fields;
}

export function dataCheckString(fields: Map<string, string>): string {
  return [...fields.keys()]
    .filter((k) => k !== "hash")
    .sort()
    .map((k) => `${k}=${fields.get(k)}`)
    .join("\n");
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function optString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * Validate raw Telegram.WebApp.initData and return the user. Throws InitDataError.
 * `nowSeconds` is injectable for tests.
 */
export async function validateInitData(
  initData: string | null | undefined,
  botToken: string,
  options: { maxAgeSeconds?: number; nowSeconds?: number } = {},
): Promise<TelegramUser> {
  if (!botToken) throw new InitDataError("bot token is not configured");
  if (!initData || initData.length > MAX_INIT_DATA_LENGTH) {
    throw new InitDataError("init data is missing or too long");
  }
  const fields = parseInitData(initData);
  const received = hexToBytes(fields.get("hash") ?? "");
  if (!received) throw new InitDataError("hash is missing or malformed");

  // crypto.subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify(
    "HMAC",
    await dataKey(botToken),
    received,
    encoder.encode(dataCheckString(fields)),
  );
  if (!ok) throw new InitDataError("hash mismatch");

  const authDateRaw = fields.get("auth_date") ?? "";
  if (!/^\d{1,12}$/.test(authDateRaw)) throw new InitDataError("auth_date is invalid");
  const authDate = Number(authDateRaw);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (now - authDate > (options.maxAgeSeconds ?? MAX_AGE_SECONDS)) {
    throw new InitDataError("init data expired", true);
  }
  if (authDate - now > MAX_FUTURE_SKEW_SECONDS) throw new InitDataError("auth_date is in the future");

  let user: unknown;
  try {
    user = JSON.parse(fields.get("user") ?? "");
  } catch {
    throw new InitDataError("user field is invalid");
  }
  if (typeof user !== "object" || user === null || Array.isArray(user)) {
    throw new InitDataError("user field is invalid");
  }
  const u = user as Record<string, unknown>;
  const id = u.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || id >= MAX_TELEGRAM_ID) {
    throw new InitDataError("user id is invalid");
  }
  return {
    id,
    first_name: optString(u.first_name) ?? "",
    last_name: optString(u.last_name),
    username: optString(u.username),
  };
}

/** Constant-time string comparison (for webhook / admin secrets). */
export function timingSafeEqualString(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
