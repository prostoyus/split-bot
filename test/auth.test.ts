import { describe, expect, it } from "vitest";
import { InitDataError, timingSafeEqualString, validateInitData } from "../src/api/auth";
import { ALICE, TEST_BOT_TOKEN, makeInitData } from "./helpers";

function fieldsOf(raw: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(raw));
}

async function expectInvalid(raw: string, token = TEST_BOT_TOKEN): Promise<InitDataError> {
  const err = await validateInitData(raw, token).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(InitDataError);
  return err as InitDataError;
}

describe("validateInitData", () => {
  it("accepts valid init data", async () => {
    const user = await validateInitData(await makeInitData(ALICE), TEST_BOT_TOKEN);
    expect(user).toEqual({ id: 1001, first_name: "Алиса", last_name: "Иванова", username: "alice" });
  });

  it("rejects a tampered user", async () => {
    const f = fieldsOf(await makeInitData(ALICE));
    f.user = f.user!.replace("1001", "9999");
    await expectInvalid(new URLSearchParams(f).toString());
  });

  it("rejects a tampered hash", async () => {
    const f = fieldsOf(await makeInitData(ALICE));
    f.hash = (f.hash![0] === "0" ? "1" : "0") + f.hash!.slice(1);
    await expectInvalid(new URLSearchParams(f).toString());
  });

  it("rejects a wrong bot token", async () => {
    await expectInvalid(await makeInitData(ALICE, { token: "999:other" }));
  });

  it("rejects an empty bot token", async () => {
    await expectInvalid(await makeInitData(ALICE), "");
  });

  it("rejects expired data and flags it", async () => {
    const old = Math.floor(Date.now() / 1000) - 24 * 3600 - 10;
    const err = await expectInvalid(await makeInitData(ALICE, { authDate: old }));
    expect(err.expired).toBe(true);
  });

  it("accepts almost expired data", async () => {
    const recent = Math.floor(Date.now() / 1000) - 24 * 3600 + 60;
    const user = await validateInitData(await makeInitData(ALICE, { authDate: recent }), TEST_BOT_TOKEN);
    expect(user.id).toBe(1001);
  });

  it("allows 5 minutes of future clock skew, not more", async () => {
    const now = Math.floor(Date.now() / 1000);
    const user = await validateInitData(await makeInitData(ALICE, { authDate: now + 240 }), TEST_BOT_TOKEN);
    expect(user.id).toBe(1001);
    const err = await expectInvalid(await makeInitData(ALICE, { authDate: now + 600 }));
    expect(err.expired).toBe(false);
  });

  it("rejects duplicate keys", async () => {
    const raw = await makeInitData(ALICE);
    await expectInvalid(`${raw}&auth_date=1`);
    await expectInvalid(`user=${encodeURIComponent(JSON.stringify({ id: 5 }))}&${raw}`);
  });

  it.each(["", "garbage", "hash=abc", "auth_date=1&auth_date=2&hash=x", "a=%FF&hash=%D0%96", "&&", "=x"])(
    "rejects malformed %j",
    async (raw) => {
      await expectInvalid(raw);
    },
  );

  it("rejects a correctly signed but invalid user field", async () => {
    for (const user of [{ id: "1" }, { id: -1 }, { id: 1.5 }, { name: "x" }]) {
      await expectInvalid(await makeInitData(user));
    }
  });
});

describe("timingSafeEqualString", () => {
  it("compares", () => {
    expect(timingSafeEqualString("abc", "abc")).toBe(true);
    expect(timingSafeEqualString("abc", "abd")).toBe(false);
    expect(timingSafeEqualString("abc", "abcd")).toBe(false);
    expect(timingSafeEqualString("", "")).toBe(true);
  });
});
