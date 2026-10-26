/** Pure split / settlement math. All amounts are integer minor units. */

import { BadRequestError } from "./errors";
import { formatMoney } from "./money";

export interface ShareInput {
  userId: number;
  amount: number;
}

export interface Transfer {
  from: number;
  to: number;
  amount: number;
}

/**
 * Split `amount` equally; remainder units go one each to the lowest user ids.
 * Returns a Map ordered by user id. Duplicate ids are collapsed.
 */
export function splitEqually(amount: number, participantIds: readonly number[]): Map<number, number> {
  const ids = [...new Set(participantIds)].sort((a, b) => a - b);
  if (ids.length === 0) throw new RangeError("participants must not be empty");
  const base = Math.floor(amount / ids.length);
  const remainder = amount - base * ids.length;
  const result = new Map<number, number>();
  ids.forEach((id, i) => result.set(id, base + (i < remainder ? 1 : 0)));
  return result;
}

/**
 * Validate client-given shares: non-empty, unique users, each an integer > 0, sum == amount.
 * Returns a Map ordered by user id. Throws BadRequestError with a Russian message.
 */
export function validateExactShares(
  amount: number,
  shares: readonly ShareInput[],
  currency: string,
  maxParticipants = 200,
): Map<number, number> {
  if (shares.length === 0) throw new BadRequestError("Укажите доли участников");
  if (shares.length > maxParticipants) throw new BadRequestError("Слишком много участников");
  const seen = new Map<number, number>();
  let total = 0;
  for (const { userId, amount: share } of shares) {
    if (seen.has(userId)) throw new BadRequestError("Участники не должны повторяться");
    if (!Number.isSafeInteger(share) || share <= 0) {
      throw new BadRequestError("Доля каждого участника должна быть больше нуля");
    }
    seen.set(userId, share);
    total += share;
  }
  if (total !== amount) {
    throw new BadRequestError(
      `Сумма долей (${formatMoney(total, currency)}) не совпадает ` +
        `с суммой траты (${formatMoney(amount, currency)})`,
    );
  }
  return new Map([...seen.entries()].sort((a, b) => a[0] - b[0]));
}

/**
 * Greedy: repeatedly match the largest debtor with the largest creditor.
 * Ties are broken by the lower user id. nets: user id -> net (> 0 is owed money).
 */
export function minimizeTransfers(nets: ReadonlyMap<number, number>): Transfer[] {
  const debtors = new Map<number, number>();
  const creditors = new Map<number, number>();
  for (const [id, net] of nets) {
    if (net < 0) debtors.set(id, -net);
    else if (net > 0) creditors.set(id, net);
  }
  const pick = (m: Map<number, number>): number => {
    let best = -1;
    let bestValue = -1;
    for (const [id, value] of m) {
      if (value > bestValue || (value === bestValue && id < best)) {
        best = id;
        bestValue = value;
      }
    }
    return best;
  };
  const transfers: Transfer[] = [];
  while (debtors.size > 0 && creditors.size > 0) {
    const d = pick(debtors);
    const c = pick(creditors);
    const dv = debtors.get(d)!;
    const cv = creditors.get(c)!;
    const amount = Math.min(dv, cv);
    transfers.push({ from: d, to: c, amount });
    if (dv === amount) debtors.delete(d);
    else debtors.set(d, dv - amount);
    if (cv === amount) creditors.delete(c);
    else creditors.set(c, cv - amount);
  }
  return transfers;
}
