import { describe, expect, it } from "vitest";
import { BadRequestError } from "../src/core/errors";
import { formatMoney } from "../src/core/money";
import { minimizeTransfers, splitEqually, validateExactShares } from "../src/core/split";

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randint = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

const obj = (m: Map<number, number>) => Object.fromEntries(m);
const tr = (nets: Record<number, number>) =>
  minimizeTransfers(new Map(Object.entries(nets).map(([k, v]) => [Number(k), v]))).map((t) => [
    t.from,
    t.to,
    t.amount,
  ]);

describe("splitEqually", () => {
  it("splits exactly", () => {
    expect(obj(splitEqually(300, [3, 1, 2]))).toEqual({ 1: 100, 2: 100, 3: 100 });
  });

  it("gives remainder kopecks to the lowest ids", () => {
    expect([...splitEqually(1000, [30, 10, 20])]).toEqual([
      [10, 334],
      [20, 333],
      [30, 333],
    ]);
  });

  it("handles amount smaller than participants", () => {
    expect(obj(splitEqually(2, [5, 4, 3]))).toEqual({ 3: 1, 4: 1, 5: 0 });
  });

  it("always sums to the amount (random)", () => {
    const r = rng(42);
    for (let i = 0; i < 500; i++) {
      const ids = new Set<number>();
      const n = randint(r, 1, 15);
      while (ids.size < n) ids.add(randint(r, 1, 999));
      const amount = randint(r, 1, 10 ** 10);
      const shares = [...splitEqually(amount, [...ids]).values()];
      expect(shares.reduce((a, b) => a + b, 0)).toBe(amount);
      expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
    }
  });

  it("throws on empty participants", () => {
    expect(() => splitEqually(100, [])).toThrow(RangeError);
  });
});

describe("validateExactShares", () => {
  const run = (shares: [number, number][], amount = 1000) =>
    validateExactShares(
      amount,
      shares.map(([userId, a]) => ({ userId, amount: a })),
      "RUB",
    );
  const msg = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestError);
      return (e as Error).message;
    }
    throw new Error("expected an error");
  };

  it("returns shares ordered by user id", () => {
    expect([...run([[3, 700], [1, 300]])]).toEqual([
      [1, 300],
      [3, 700],
    ]);
  });

  it("validates", () => {
    expect(msg(() => run([[1, 600], [2, 300]]))).toBe("Сумма долей (9 ₽) не совпадает с суммой траты (10 ₽)");
    expect(msg(() => run([[1, 1000], [2, 0]]))).toBe("Доля каждого участника должна быть больше нуля");
    expect(msg(() => run([[1, 1100], [2, -100]]))).toBe("Доля каждого участника должна быть больше нуля");
    expect(msg(() => run([[1, 999.5], [2, 0.5]]))).toBe("Доля каждого участника должна быть больше нуля");
    expect(msg(() => run([[1, 500], [1, 500]]))).toBe("Участники не должны повторяться");
    expect(msg(() => run([]))).toBe("Укажите доли участников");
  });
});

describe("minimizeTransfers", () => {
  it("simple", () => {
    expect(tr({ 1: 200, 2: -100, 3: -100 })).toEqual([
      [2, 1, 100],
      [3, 1, 100],
    ]);
  });

  it("largest first with tie-break by lower id", () => {
    expect(tr({ 1: 500, 2: 300, 3: -600, 4: -200 })).toEqual([
      [3, 1, 500],
      [4, 2, 200],
      [3, 2, 100],
    ]);
    expect(tr({ 5: 100, 2: 100, 9: -100, 3: -100 })).toEqual([
      [3, 2, 100],
      [9, 5, 100],
    ]);
  });

  it("settles everything (random)", () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const n = randint(r, 2, 10);
      const nets = new Map<number, number>();
      let sum = 0;
      for (let u = 1; u < n; u++) {
        const v = randint(r, -(10 ** 6), 10 ** 6);
        nets.set(u, v);
        sum += v;
      }
      nets.set(n, -sum);
      const transfers = minimizeTransfers(nets);
      expect(transfers.length).toBeLessThanOrEqual(n - 1);
      const result = new Map(nets);
      for (const t of transfers) {
        expect(t.amount).toBeGreaterThan(0);
        result.set(t.from, result.get(t.from)! + t.amount);
        result.set(t.to, result.get(t.to)! - t.amount);
      }
      expect([...result.values()].every((v) => v === 0)).toBe(true);
    }
  });

  it("all zero", () => {
    expect(tr({ 1: 0, 2: 0 })).toEqual([]);
  });
});

describe("formatMoney", () => {
  it.each([
    [150050, "RUB", "1 500,50 ₽"],
    [150000, "RUB", "1 500 ₽"],
    [5, "USD", "0,05 $"],
    [-123456789, "EUR", "-1 234 567,89 €"],
    [0, "KZT", "0 ₸"],
    [10_000_000_000, "UZS", "100 000 000 сум"],
  ] as const)("%d %s -> %s", (amount, currency, expected) => {
    expect(formatMoney(amount, currency)).toBe(expected);
  });
});
