/** D1 row types, row mapping and small helpers. */

/** User object used everywhere (API shape): name = first + last name. */
export interface UserRef {
  id: number;
  name: string;
  username: string | null;
}

export interface UserRow {
  id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
}

export interface EventRow {
  id: number;
  title: string;
  currency: string;
  invite_code: string;
  owner_id: number;
  created_at: number;
}

export interface Event {
  id: number;
  title: string;
  currency: string;
  inviteCode: string;
  ownerId: number;
  /** Unix ms. */
  createdAt: number;
}

export interface ExpenseRow {
  id: number;
  event_id: number;
  payer_id: number;
  amount: number;
  description: string;
  split_mode: "equal" | "exact";
  created_by: number;
  created_at: number;
}

export interface ShareRow {
  expense_id: number;
  user_id: number;
  amount: number;
}

export interface SettlementRow {
  id: number;
  event_id: number;
  from_id: number;
  to_id: number;
  amount: number;
  status: "pending" | "confirmed" | "rejected";
  created_at: number;
  resolved_at: number | null;
}

export const USER_COLUMNS = "u.id, u.first_name, u.last_name, u.username";
export const EVENT_COLUMNS = "e.id, e.title, e.currency, e.invite_code, e.owner_id, e.created_at";

export function displayName(row: Pick<UserRow, "id" | "first_name" | "last_name" | "username">): string {
  const name = [row.first_name, row.last_name].filter((p) => p).join(" ").trim();
  return name || row.username || `id${row.id}`;
}

export function toUserRef(row: UserRow): UserRef {
  return { id: row.id, name: displayName(row), username: row.username || null };
}

export function toEvent(row: EventRow): Event {
  return {
    id: row.id,
    title: row.title,
    currency: row.currency,
    inviteCode: row.invite_code,
    ownerId: row.owner_id,
    createdAt: row.created_at,
  };
}

/** Users by id; unknown ids (should not happen) get a stub so views never crash. */
export class UserDirectory {
  private readonly byId = new Map<number, UserRef>();

  constructor(rows: Iterable<UserRow>) {
    for (const row of rows) this.byId.set(row.id, toUserRef(row));
  }

  get(id: number): UserRef {
    return this.byId.get(id) ?? { id, name: `id${id}`, username: null };
  }

  has(id: number): boolean {
    return this.byId.has(id);
  }

  ids(): number[] {
    return [...this.byId.keys()];
  }
}

/** Collapse { user_id, net } rows into a Map. */
export function netsFromRows(rows: readonly { user_id: number; net: number }[]): Map<number, number> {
  const nets = new Map<number, number>();
  for (const r of rows) nets.set(r.user_id, Number(r.net) || 0);
  return nets;
}

/**
 * SQL computing { user_id, net } for one event (param ?1 = event id). Every member is present.
 * net = paid - own shares + confirmed sent - confirmed received.
 */
export const EVENT_NETS_SQL = `
SELECT user_id, SUM(v) AS net FROM (
  SELECT user_id, 0 AS v FROM members WHERE event_id = ?1
  UNION ALL SELECT payer_id, amount FROM expenses WHERE event_id = ?1
  UNION ALL SELECT s.user_id, -s.amount FROM expense_shares s
            JOIN expenses x ON x.id = s.expense_id WHERE x.event_id = ?1
  UNION ALL SELECT from_id, amount FROM settlements WHERE event_id = ?1 AND status = 'confirmed'
  UNION ALL SELECT to_id, -amount FROM settlements WHERE event_id = ?1 AND status = 'confirmed'
) GROUP BY user_id`;

/**
 * SQL computing { event_id, user_id, net } for every event the user ?1 is a member of.
 */
export const USER_EVENTS_NETS_SQL = `
WITH my AS (SELECT event_id FROM members WHERE user_id = ?1)
SELECT event_id, user_id, SUM(v) AS net FROM (
  SELECT event_id, user_id, 0 AS v FROM members WHERE event_id IN (SELECT event_id FROM my)
  UNION ALL SELECT event_id, payer_id, amount FROM expenses WHERE event_id IN (SELECT event_id FROM my)
  UNION ALL SELECT x.event_id, s.user_id, -s.amount FROM expense_shares s
            JOIN expenses x ON x.id = s.expense_id WHERE x.event_id IN (SELECT event_id FROM my)
  UNION ALL SELECT event_id, from_id, amount FROM settlements
            WHERE event_id IN (SELECT event_id FROM my) AND status = 'confirmed'
  UNION ALL SELECT event_id, to_id, -amount FROM settlements
            WHERE event_id IN (SELECT event_id FROM my) AND status = 'confirmed'
) GROUP BY event_id, user_id`;

/** Event row + whether user ?2 is a member (param ?1 = event id). */
export const EVENT_WITH_MEMBERSHIP_SQL = `
SELECT ${EVENT_COLUMNS},
       EXISTS (SELECT 1 FROM members m WHERE m.event_id = e.id AND m.user_id = ?2) AS is_member
FROM events e WHERE e.id = ?1`;

/** Members of event ?1 with user data, in join order. */
export const EVENT_MEMBERS_SQL = `
SELECT ${USER_COLUMNS} FROM members m JOIN users u ON u.id = m.user_id
WHERE m.event_id = ?1 ORDER BY m.joined_at, m.user_id`;

export type EventWithMembershipRow = EventRow & { is_member: number };

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return `${err.message} ${cause instanceof Error ? cause.message : ""}`;
  }
  return String(err);
}

export function isUniqueViolation(err: unknown): boolean {
  return /UNIQUE constraint failed/i.test(errorText(err));
}

export function isForeignKeyViolation(err: unknown): boolean {
  return /FOREIGN KEY constraint failed/i.test(errorText(err));
}

/** Unix ms -> ISO 8601 with "Z" and second precision (same format as v1). */
export function toIso(ms: number): string;
export function toIso(ms: number | null): string | null;
export function toIso(ms: number | null): string | null {
  if (ms === null || ms === undefined) return null;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
