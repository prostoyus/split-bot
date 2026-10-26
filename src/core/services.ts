/**
 * Business use cases shared by the REST API and the bot. No Telegram imports.
 *
 * Every function takes `deps` first. Mutations notify (fire-and-forget) only after their
 * DB writes succeeded. Errors are ServiceError subclasses with Russian messages.
 * D1 round trips are minimised with db.batch (one round trip per batch, run in a transaction).
 */

import {
  EVENT_COLUMNS,
  EVENT_MEMBERS_SQL,
  EVENT_NETS_SQL,
  EVENT_WITH_MEMBERSHIP_SQL,
  USER_COLUMNS,
  USER_EVENTS_NETS_SQL,
  UserDirectory,
  isForeignKeyViolation,
  isUniqueViolation,
  netsFromRows,
  toEvent,
  toUserRef,
  type Event,
  type EventRow,
  type EventWithMembershipRow,
  type ExpenseRow,
  type SettlementRow,
  type ShareRow,
  type UserRef,
  type UserRow,
} from "./db";
import { BadRequestError, ForbiddenError, NotFoundError } from "./errors";
import { CURRENCIES, formatMoney, isCurrency } from "./money";
import { escapeHtml, safeNotify, type Notifier } from "./notify";
import { minimizeTransfers, splitEqually, validateExactShares, type ShareInput } from "./split";

export type { Event, UserRef } from "./db";
export type { ShareInput, Transfer } from "./split";

// ---------------------------------------------------------------- constants

export const MAX_AMOUNT = 10_000_000_000; // minor units
export const TITLE_MAX_LEN = 64;
export const DESCRIPTION_MAX_LEN = 100;
export const INVITE_CODE_LEN = 10;
export const INVITE_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export const MAX_MEMBERS = 40;
export const MAX_EVENTS_PER_OWNER = 50;
export const MAX_EXPENSES_PER_EVENT = 1000;
export const MAX_PARTICIPANTS = 200;
export const SPLIT_MODES = ["equal", "exact"] as const;
export type SplitMode = (typeof SPLIT_MODES)[number];

const PENDING_EXISTS_MESSAGE = "Предыдущий возврат ещё ждёт подтверждения";
const NOT_MEMBER_MESSAGE = "Вы не участник этого события";

// ---------------------------------------------------------------- types

export interface Deps {
  db: D1Database;
  notify: Notifier;
  /** Bot username without "@" (used for invite links). */
  botUsername?: string;
}

/** Compatible with grammY's `ctx.from` and with the parsed initData user. */
export interface TelegramUserInput {
  id: number;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
}

export interface EventSummary {
  id: number;
  title: string;
  currency: string;
  membersCount: number;
  myNet: number;
}

export interface EventDetail {
  event: Event;
  /** Members in join order. */
  members: UserRef[];
  myNet: number;
}

export interface JoinResult {
  event: Event;
  joinedNow: boolean;
  /** Event detail from the joining user's point of view (saves a round trip). */
  detail: EventDetail;
}

export interface AddExpenseInput {
  amount: number;
  description: string;
  payerId: number;
  /** Default "equal". */
  split?: string | null;
  /** Required for "equal", must be absent (undefined/null) for "exact". */
  participantIds?: readonly number[] | null;
  /** Required for "exact", must be absent (undefined/null) for "equal". */
  shares?: readonly ShareInput[] | null;
}

export interface ShareView {
  user: UserRef;
  amount: number;
}

export interface ExpenseView {
  id: number;
  eventId: number;
  payer: UserRef;
  amount: number;
  description: string;
  split: SplitMode;
  /** Unix ms. */
  createdAt: number;
  createdBy: number;
  /** Ordered by user id. */
  shares: ShareView[];
}

export interface BalanceView {
  user: UserRef;
  net: number;
}

export interface TransferView {
  from: UserRef;
  to: UserRef;
  amount: number;
}

export interface EventBalances {
  /** Ordered by net desc, then user id. */
  balances: BalanceView[];
  transfers: TransferView[];
}

export type SettlementStatus = "pending" | "confirmed" | "rejected";

export interface SettlementView {
  id: number;
  eventId: number;
  from: UserRef;
  to: UserRef;
  amount: number;
  status: SettlementStatus;
  /** Unix ms. */
  createdAt: number;
  resolvedAt: number | null;
}

export interface UserEventDebts {
  eventId: number;
  title: string;
  currency: string;
  net: number;
  /** The user pays these people. */
  owes: { toUser: UserRef; amount: number }[];
  /** These people pay the user. */
  owedBy: { fromUser: UserRef; amount: number }[];
}

export interface DebtReminder {
  eventId: number;
  eventTitle: string;
  currency: string;
  userId: number;
  /** How much the user owes (positive). */
  amount: number;
}

// ---------------------------------------------------------------- helpers

function rows<T>(result: D1Result | undefined): T[] {
  return (result?.results ?? []) as T[];
}

function cleanText(value: unknown, maxLen: number, what: string): string {
  if (typeof value !== "string") throw new BadRequestError(`Поле «${what}» должно быть строкой`);
  const text = value.split(/\s+/).filter(Boolean).join(" ");
  if (!text) throw new BadRequestError(`Поле «${what}» не может быть пустым`);
  if ([...text].length > maxLen) {
    throw new BadRequestError(`Поле «${what}» слишком длинное (максимум ${maxLen} символов)`);
  }
  return text;
}

function checkAmount(amount: unknown): number {
  if (typeof amount !== "number" || !Number.isInteger(amount)) {
    throw new BadRequestError("Сумма должна быть целым числом");
  }
  if (amount <= 0) throw new BadRequestError("Сумма должна быть больше нуля");
  if (amount > MAX_AMOUNT) throw new BadRequestError("Сумма слишком большая");
  return amount;
}

function checkCurrency(currency: string | null | undefined): string {
  const code = (currency || "RUB").trim().toUpperCase();
  if (!isCurrency(code)) {
    throw new BadRequestError("Неподдерживаемая валюта. Доступны: " + CURRENCIES.join(", "));
  }
  return code;
}

function bold(user: UserRef | undefined): string {
  return `<b>${user ? escapeHtml(user.name) : "Кто-то"}</b>`;
}

function newInviteCode(): string {
  const bytes = new Uint8Array(INVITE_CODE_LEN);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const b of bytes) code += INVITE_CODE_ALPHABET[b & 63];
  return code;
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const chars = [...value];
  return chars.length > max ? chars.slice(0, max).join("") : value;
}

/** Run `extra` statements in one batch after the event/membership lookup; throws 404/403. */
async function memberBatch(
  deps: Deps,
  eventId: number,
  userId: number,
  extra: D1PreparedStatement[],
): Promise<{ event: Event; results: D1Result[] }> {
  const res = await deps.db.batch([
    deps.db.prepare(EVENT_WITH_MEMBERSHIP_SQL).bind(eventId, userId),
    ...extra,
  ]);
  const row = rows<EventWithMembershipRow>(res[0])[0];
  if (!row) throw new NotFoundError("Событие не найдено");
  if (!row.is_member) throw new ForbiddenError(NOT_MEMBER_MESSAGE);
  return { event: toEvent(row), results: res.slice(1) };
}

function membersStmt(deps: Deps, eventId: number): D1PreparedStatement {
  return deps.db.prepare(EVENT_MEMBERS_SQL).bind(eventId);
}

function netsStmt(deps: Deps, eventId: number): D1PreparedStatement {
  return deps.db.prepare(EVENT_NETS_SQL).bind(eventId);
}

// ---------------------------------------------------------------- users

/** Insert or update a Telegram user (one write; no-op update when nothing changed). */
export async function upsertUser(deps: Deps, user: TelegramUserInput, now: number = Date.now()): Promise<UserRef> {
  if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new BadRequestError("Некорректный пользователь");
  const firstName = truncate(user.first_name, 128) ?? "";
  const lastName = truncate(user.last_name, 128);
  const username = truncate(user.username, 64);
  await deps.db
    .prepare(
      `INSERT INTO users (id, first_name, last_name, username, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (id) DO UPDATE SET
         first_name = excluded.first_name, last_name = excluded.last_name, username = excluded.username
       WHERE users.first_name IS NOT excluded.first_name
          OR users.last_name IS NOT excluded.last_name
          OR users.username IS NOT excluded.username`,
    )
    .bind(user.id, firstName, lastName, username, now)
    .run();
  return toUserRef({ id: user.id, first_name: firstName, last_name: lastName, username });
}

export async function getUser(deps: Deps, userId: number): Promise<UserRef | null> {
  const row = await deps.db
    .prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?1`)
    .bind(userId)
    .first<UserRow>();
  return row ? toUserRef(row) : null;
}

// ---------------------------------------------------------------- events & members

/** Create an event; the owner becomes its first member. Returns the owner's view of it. */
export async function createEvent(
  deps: Deps,
  ownerId: number,
  title: string,
  currency: string | null = "RUB",
): Promise<EventDetail> {
  const cleanTitle = cleanText(title, TITLE_MAX_LEN, "название");
  const code = checkCurrency(currency);
  const now = Date.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const invite = newInviteCode();
    let res: D1Result[];
    try {
      res = await deps.db.batch([
        deps.db
          .prepare(
            `INSERT INTO events (title, currency, invite_code, owner_id, created_at)
             SELECT ?1, ?2, ?3, ?4, ?5
             WHERE (SELECT COUNT(*) FROM events WHERE owner_id = ?4) < ?6
             RETURNING id, title, currency, invite_code, owner_id, created_at`,
          )
          .bind(cleanTitle, code, invite, ownerId, now, MAX_EVENTS_PER_OWNER),
        deps.db
          .prepare(
            `INSERT INTO members (event_id, user_id, joined_at)
             SELECT id, ?2, ?3 FROM events WHERE invite_code = ?1`,
          )
          .bind(invite, ownerId, now),
        deps.db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?1`).bind(ownerId),
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) continue; // invite code collision: try another one
      if (isForeignKeyViolation(err)) throw new NotFoundError("Пользователь не найден");
      throw err;
    }
    const inserted = rows<EventRow>(res[0])[0];
    // Limit reached: nothing was inserted (the member insert matched no event either).
    if (!inserted) throw new BadRequestError(`Слишком много событий (максимум ${MAX_EVENTS_PER_OWNER})`);
    const event = toEvent(inserted);
    const owner = rows<UserRow>(res[2])[0];
    return { event, members: owner ? [toUserRef(owner)] : [], myNet: 0 };
  }
  throw new Error("could not generate a unique invite code");
}

/** Event row by id; 404 if unknown. No permission check. */
export async function getEvent(deps: Deps, eventId: number): Promise<Event> {
  const row = await deps.db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM events e WHERE e.id = ?1`)
    .bind(eventId)
    .first<EventRow>();
  if (!row) throw new NotFoundError("Событие не найдено");
  return toEvent(row);
}

export async function isMember(deps: Deps, eventId: number, userId: number): Promise<boolean> {
  const row = await deps.db
    .prepare("SELECT 1 AS ok FROM members WHERE event_id = ?1 AND user_id = ?2")
    .bind(eventId, userId)
    .first();
  return row !== null;
}

/** Event detail for a member (404 unknown event, 403 not a member). */
export async function getEventDetail(deps: Deps, eventId: number, userId: number): Promise<EventDetail> {
  const { event, results } = await memberBatch(deps, eventId, userId, [
    membersStmt(deps, eventId),
    netsStmt(deps, eventId),
  ]);
  const members = rows<UserRow>(results[0]).map(toUserRef);
  const nets = netsFromRows(rows(results[1]));
  return { event, members, myNet: nets.get(userId) ?? 0 };
}

/** Accepts "CODE" or "join_CODE" (deep-link payload). */
export function parseInviteCode(codeOrJoinPayload: string): string | null {
  let code = (codeOrJoinPayload ?? "").trim();
  if (code.startsWith("join_")) code = code.slice("join_".length);
  if (!code || code.length > 32) return null;
  for (const ch of code) if (!INVITE_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/**
 * Join an event by invite code or "join_<code>" payload. Idempotent.
 * 404 unknown code/user, 400 when the event already has MAX_MEMBERS members.
 * Notifies the other members when the user joined now.
 */
export async function joinByInviteCode(
  deps: Deps,
  userId: number,
  codeOrJoinPayload: string,
): Promise<JoinResult> {
  const code = parseInviteCode(codeOrJoinPayload);
  if (!code) throw new NotFoundError("Приглашение не найдено");
  const eventRow = await deps.db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM events e WHERE e.invite_code = ?1`)
    .bind(code)
    .first<EventRow>();
  if (!eventRow) throw new NotFoundError("Приглашение не найдено");
  const event = toEvent(eventRow);

  let res: D1Result[];
  try {
    res = await deps.db.batch([
      deps.db
        .prepare(
          `INSERT INTO members (event_id, user_id, joined_at)
           SELECT ?1, ?2, ?3
           WHERE (SELECT COUNT(*) FROM members WHERE event_id = ?1) < ?4
           ON CONFLICT DO NOTHING`,
        )
        .bind(event.id, userId, Date.now(), MAX_MEMBERS),
      membersStmt(deps, event.id),
      netsStmt(deps, event.id),
    ]);
  } catch (err) {
    if (isForeignKeyViolation(err)) throw new NotFoundError("Пользователь не найден");
    throw err;
  }
  const joinedNow = (res[0]?.meta.changes ?? 0) === 1;
  const members = rows<UserRow>(res[1]).map(toUserRef);
  const me = members.find((m) => m.id === userId);
  if (!me) throw new BadRequestError("В событии уже максимум участников");
  const nets = netsFromRows(rows(res[2]));

  if (joinedNow) {
    const text = `${bold(me)} присоединился(-ась) к событию «${escapeHtml(event.title)}»`;
    for (const m of members) {
      if (m.id !== userId) safeNotify(deps.notify, m.id, text, { eventId: event.id });
    }
  }
  return { event, joinedNow, detail: { event, members, myNet: nets.get(userId) ?? 0 } };
}

/** User's events, newest first, with members count and the user's net (one query). */
export async function listUserEvents(deps: Deps, userId: number): Promise<EventSummary[]> {
  const res = await deps.db
    .prepare(
      `SELECT e.id, e.title, e.currency,
         (SELECT COUNT(*) FROM members m2 WHERE m2.event_id = e.id) AS members_count,
         COALESCE((SELECT SUM(amount) FROM expenses WHERE event_id = e.id AND payer_id = ?1), 0)
         - COALESCE((SELECT SUM(s.amount) FROM expense_shares s JOIN expenses x ON x.id = s.expense_id
                     WHERE x.event_id = e.id AND s.user_id = ?1), 0)
         + COALESCE((SELECT SUM(amount) FROM settlements
                     WHERE event_id = e.id AND from_id = ?1 AND status = 'confirmed'), 0)
         - COALESCE((SELECT SUM(amount) FROM settlements
                     WHERE event_id = e.id AND to_id = ?1 AND status = 'confirmed'), 0) AS my_net
       FROM members m JOIN events e ON e.id = m.event_id
       WHERE m.user_id = ?1
       ORDER BY e.created_at DESC, e.id DESC`,
    )
    .bind(userId)
    .all<{ id: number; title: string; currency: string; members_count: number; my_net: number }>();
  return res.results.map((r) => ({
    id: r.id,
    title: r.title,
    currency: r.currency,
    membersCount: r.members_count,
    myNet: Number(r.my_net) || 0,
  }));
}

// ---------------------------------------------------------------- expenses

function resolveShares(input: AddExpenseInput, amount: number, currency: string): {
  split: SplitMode;
  shares: Map<number, number>;
} {
  const split = input.split ?? "equal";
  const participants = input.participantIds;
  const shares = input.shares;
  if (split === "equal") {
    if (shares !== undefined && shares !== null) {
      throw new BadRequestError("При равном делении доли не указываются");
    }
    if (!participants || participants.length === 0) {
      throw new BadRequestError("Выберите хотя бы одного участника");
    }
    if (participants.length > MAX_PARTICIPANTS) throw new BadRequestError("Слишком много участников");
    if (new Set(participants).size !== participants.length) {
      throw new BadRequestError("Участники не должны повторяться");
    }
    return { split, shares: splitEqually(amount, participants) };
  }
  if (split === "exact") {
    if (participants !== undefined && participants !== null) {
      throw new BadRequestError("При точном делении укажите доли, а не список участников");
    }
    if (shares === undefined || shares === null) throw new BadRequestError("Укажите доли участников");
    return { split, shares: validateExactShares(amount, shares, currency, MAX_PARTICIPANTS) };
  }
  throw new BadRequestError("Неизвестный способ деления траты");
}

/**
 * Add an expense (expense + shares written atomically in one batch). Notifies the payer and
 * participants except the actor; participants see their own share.
 */
export async function addExpense(
  deps: Deps,
  eventId: number,
  actorId: number,
  input: AddExpenseInput,
): Promise<ExpenseView> {
  const { event, results } = await memberBatch(deps, eventId, actorId, [
    membersStmt(deps, eventId),
    deps.db.prepare("SELECT COUNT(*) AS n FROM expenses WHERE event_id = ?1").bind(eventId),
  ]);
  const amount = checkAmount(input.amount);
  const description = cleanText(input.description, DESCRIPTION_MAX_LEN, "описание");
  const { split, shares } = resolveShares(input, amount, event.currency);
  // Check-then-insert: concurrent requests may overshoot by a few rows, which is acceptable.
  if (Number(rows<{ n: number }>(results[1])[0]?.n ?? 0) >= MAX_EXPENSES_PER_EVENT) {
    throw new BadRequestError(`В событии слишком много трат (максимум ${MAX_EXPENSES_PER_EVENT})`);
  }

  const users = new UserDirectory(rows<UserRow>(results[0]));
  if (!users.has(input.payerId)) throw new BadRequestError("Плательщик должен быть участником события");
  for (const uid of shares.keys()) {
    if (!users.has(uid)) throw new BadRequestError("Все участники траты должны быть участниками события");
  }

  const now = Date.now();
  const db = deps.db;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO expenses (event_id, payer_id, amount, description, split_mode, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`,
      )
      .bind(eventId, input.payerId, amount, description, split, actorId, now),
  ];
  // The batch is one transaction and AUTOINCREMENT ids grow, so MAX(id) is the row just inserted.
  const shareSql = db.prepare(
    "INSERT INTO expense_shares (expense_id, user_id, amount) VALUES ((SELECT MAX(id) FROM expenses), ?1, ?2)",
  );
  for (const [uid, share] of shares) stmts.push(shareSql.bind(uid, share));
  const res = await db.batch(stmts);
  const id = rows<{ id: number }>(res[0])[0]!.id;

  const view: ExpenseView = {
    id,
    eventId,
    payer: users.get(input.payerId),
    amount,
    description,
    split,
    createdAt: now,
    createdBy: actorId,
    shares: [...shares].map(([uid, a]) => ({ user: users.get(uid), amount: a })),
  };

  const head =
    `${bold(users.get(actorId))} добавил(а) трату в «${escapeHtml(event.title)}»:\n` +
    `${escapeHtml(description)} — <b>${formatMoney(amount, event.currency)}</b>\n` +
    `Заплатил(а): ${escapeHtml(users.get(input.payerId).name)}`;
  const recipients = new Set<number>([...shares.keys(), input.payerId]);
  recipients.delete(actorId);
  for (const uid of [...recipients].sort((a, b) => a - b)) {
    const own = shares.get(uid);
    const text = own === undefined ? head : `${head}\nВаша доля: <b>${formatMoney(own, event.currency)}</b>`;
    safeNotify(deps.notify, uid, text, { eventId });
  }
  return view;
}

/** Expenses of an event, newest first. */
export async function listExpenses(deps: Deps, eventId: number, userId: number): Promise<ExpenseView[]> {
  const { results } = await memberBatch(deps, eventId, userId, [
    deps.db
      .prepare(
        `SELECT id, event_id, payer_id, amount, description, split_mode, created_by, created_at
         FROM expenses WHERE event_id = ?1 ORDER BY created_at DESC, id DESC`,
      )
      .bind(eventId),
    deps.db
      .prepare(
        `SELECT s.expense_id, s.user_id, s.amount FROM expense_shares s
         JOIN expenses x ON x.id = s.expense_id
         WHERE x.event_id = ?1 ORDER BY s.expense_id, s.user_id`,
      )
      .bind(eventId),
    membersStmt(deps, eventId),
  ]);
  const users = new UserDirectory(rows<UserRow>(results[2]));
  const sharesBy = new Map<number, ShareView[]>();
  for (const s of rows<ShareRow>(results[1])) {
    let list = sharesBy.get(s.expense_id);
    if (!list) sharesBy.set(s.expense_id, (list = []));
    list.push({ user: users.get(s.user_id), amount: s.amount });
  }
  return rows<ExpenseRow>(results[0]).map((x) => ({
    id: x.id,
    eventId: x.event_id,
    payer: users.get(x.payer_id),
    amount: x.amount,
    description: x.description,
    split: x.split_mode,
    createdAt: x.created_at,
    createdBy: x.created_by,
    shares: sharesBy.get(x.id) ?? [],
  }));
}

/** Delete an expense; only its creator or payer (and only while a member). */
export async function deleteExpense(deps: Deps, expenseId: number, actorId: number): Promise<void> {
  const row = await deps.db
    .prepare(
      `SELECT x.event_id, x.payer_id, x.created_by,
         EXISTS (SELECT 1 FROM members m WHERE m.event_id = x.event_id AND m.user_id = ?2) AS is_member
       FROM expenses x WHERE x.id = ?1`,
    )
    .bind(expenseId, actorId)
    .first<{ event_id: number; payer_id: number; created_by: number; is_member: number }>();
  if (!row) throw new NotFoundError("Трата не найдена");
  if (!row.is_member) throw new ForbiddenError(NOT_MEMBER_MESSAGE);
  if (actorId !== row.created_by && actorId !== row.payer_id) {
    throw new ForbiddenError("Удалить трату может только тот, кто её добавил или оплатил");
  }
  await deps.db.batch([
    deps.db.prepare("DELETE FROM expense_shares WHERE expense_id = ?1").bind(expenseId),
    deps.db.prepare("DELETE FROM expenses WHERE id = ?1").bind(expenseId),
  ]);
}

// ---------------------------------------------------------------- balances

/** { userId: net } for one event, no permission check. net > 0: others owe the user. */
export async function computeNets(deps: Deps, eventId: number): Promise<Map<number, number>> {
  const res = await netsStmt(deps, eventId).all<{ user_id: number; net: number }>();
  return netsFromRows(res.results);
}

export async function getEventBalances(deps: Deps, eventId: number, userId: number): Promise<EventBalances> {
  const { results } = await memberBatch(deps, eventId, userId, [
    membersStmt(deps, eventId),
    netsStmt(deps, eventId),
  ]);
  const users = new UserDirectory(rows<UserRow>(results[0]));
  const nets = netsFromRows(rows(results[1]));
  const balances = [...nets]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([uid, net]) => ({ user: users.get(uid), net }));
  const transfers = minimizeTransfers(nets).map((t) => ({
    from: users.get(t.from),
    to: users.get(t.to),
    amount: t.amount,
  }));
  return { balances, transfers };
}

/** What `fromId` should pay `toId` according to the current minimal transfers (0 if none). */
export function debtTo(nets: ReadonlyMap<number, number>, fromId: number, toId: number): number {
  let sum = 0;
  for (const t of minimizeTransfers(nets)) if (t.from === fromId && t.to === toId) sum += t.amount;
  return sum;
}

// ---------------------------------------------------------------- settlements

function settlementView(s: SettlementRow, users: UserDirectory): SettlementView {
  return {
    id: s.id,
    eventId: s.event_id,
    from: users.get(s.from_id),
    to: users.get(s.to_id),
    amount: s.amount,
    status: s.status,
    createdAt: s.created_at,
    resolvedAt: s.resolved_at ?? null,
  };
}

/** Record "I paid back" from `fromId` to `toId` (pending until the recipient confirms). */
export async function createSettlement(
  deps: Deps,
  eventId: number,
  fromId: number,
  toId: number,
  amount: number,
): Promise<SettlementView> {
  const { event, results } = await memberBatch(deps, eventId, fromId, [
    membersStmt(deps, eventId),
    netsStmt(deps, eventId),
    deps.db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS pending FROM settlements
         WHERE event_id = ?1 AND from_id = ?2 AND to_id = ?3 AND status = 'pending'`,
      )
      .bind(eventId, fromId, toId),
  ]);
  const value = checkAmount(amount);
  if (toId === fromId) throw new BadRequestError("Нельзя вернуть деньги самому себе");
  const users = new UserDirectory(rows<UserRow>(results[0]));
  if (!users.has(toId)) throw new BadRequestError("Получатель должен быть участником события");
  const pending = Number(rows<{ pending: number }>(results[2])[0]?.pending ?? 0);
  if (pending > 0) throw new BadRequestError(PENDING_EXISTS_MESSAGE);
  const nets = netsFromRows(rows(results[1]));
  if (value > debtTo(nets, fromId, toId) - pending) {
    throw new BadRequestError("Сумма больше вашего долга этому участнику");
  }

  const now = Date.now();
  let id: number;
  try {
    const row = await deps.db
      .prepare(
        `INSERT INTO settlements (event_id, from_id, to_id, amount, status, created_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', ?5) RETURNING id`,
      )
      .bind(eventId, fromId, toId, value, now)
      .first<{ id: number }>();
    id = row!.id;
  } catch (err) {
    // Partial unique index: a concurrent request created a pending settlement first.
    if (isUniqueViolation(err)) throw new BadRequestError(PENDING_EXISTS_MESSAGE);
    throw err;
  }

  const text =
    `${bold(users.get(fromId))} отметил(а), что вернул(а) вам ` +
    `<b>${formatMoney(value, event.currency)}</b> в «${escapeHtml(event.title)}» — подтвердите`;
  safeNotify(deps.notify, toId, text, { eventId });
  return {
    id,
    eventId,
    from: users.get(fromId),
    to: users.get(toId),
    amount: value,
    status: "pending",
    createdAt: now,
    resolvedAt: null,
  };
}

/** Settlements of an event, newest first. */
export async function listSettlements(deps: Deps, eventId: number, userId: number): Promise<SettlementView[]> {
  const { results } = await memberBatch(deps, eventId, userId, [
    deps.db
      .prepare(
        `SELECT id, event_id, from_id, to_id, amount, status, created_at, resolved_at
         FROM settlements WHERE event_id = ?1 ORDER BY created_at DESC, id DESC`,
      )
      .bind(eventId),
    membersStmt(deps, eventId),
  ]);
  const users = new UserDirectory(rows<UserRow>(results[1]));
  return rows<SettlementRow>(results[0]).map((s) => settlementView(s, users));
}

async function resolveSettlement(
  deps: Deps,
  settlementId: number,
  actorId: number,
  confirm: boolean,
): Promise<SettlementView> {
  const db = deps.db;
  const [found, people] = await db.batch([
    db
      .prepare(
        `SELECT s.id, s.event_id, s.from_id, s.to_id, s.amount, s.status, s.created_at, s.resolved_at,
           e.title, e.currency,
           EXISTS (SELECT 1 FROM members m WHERE m.event_id = s.event_id AND m.user_id = ?2) AS is_member
         FROM settlements s JOIN events e ON e.id = s.event_id WHERE s.id = ?1`,
      )
      .bind(settlementId, actorId),
    db
      .prepare(
        `SELECT ${USER_COLUMNS} FROM users u WHERE u.id IN (
           SELECT from_id FROM settlements WHERE id = ?1 UNION SELECT to_id FROM settlements WHERE id = ?1)`,
      )
      .bind(settlementId),
  ]);
  const s = rows<SettlementRow & { title: string; currency: string; is_member: number }>(found)[0];
  if (!s) throw new NotFoundError("Перевод не найден");
  if (!s.is_member) throw new ForbiddenError(NOT_MEMBER_MESSAGE);
  if (s.to_id !== actorId) {
    throw new ForbiddenError("Подтвердить или отклонить перевод может только получатель");
  }
  // Conditional update: exactly one of concurrent confirm/reject calls wins.
  const updated = await db
    .prepare(
      `UPDATE settlements SET status = ?2, resolved_at = ?3
       WHERE id = ?1 AND status = 'pending' RETURNING status, resolved_at`,
    )
    .bind(settlementId, confirm ? "confirmed" : "rejected", Date.now())
    .first<{ status: SettlementStatus; resolved_at: number }>();
  if (!updated) throw new BadRequestError("Этот возврат уже обработан");

  const users = new UserDirectory(rows<UserRow>(people));
  const money = formatMoney(s.amount, s.currency);
  const title = escapeHtml(s.title);
  const recipient = bold(users.get(s.to_id));
  const text = confirm
    ? `${recipient} подтвердил(а) получение <b>${money}</b> в «${title}»`
    : `${recipient} отклонил(а) ваш перевод <b>${money}</b> в «${title}»`;
  safeNotify(deps.notify, s.from_id, text, { eventId: s.event_id });
  return settlementView({ ...s, status: updated.status, resolved_at: updated.resolved_at }, users);
}

/** Only the recipient, only while pending (400 "Этот возврат уже обработан" otherwise). */
export function confirmSettlement(deps: Deps, settlementId: number, actorId: number): Promise<SettlementView> {
  return resolveSettlement(deps, settlementId, actorId, true);
}

/** Same rules as confirmSettlement. */
export function rejectSettlement(deps: Deps, settlementId: number, actorId: number): Promise<SettlementView> {
  return resolveSettlement(deps, settlementId, actorId, false);
}

// ---------------------------------------------------------------- bot helpers

/** Events where the user's net is non-zero (newest first), with whom the user owes / is owed by. */
export async function getUserDebtsSummary(deps: Deps, userId: number): Promise<UserEventDebts[]> {
  const db = deps.db;
  const [eventsRes, netsRes, usersRes] = await db.batch([
    db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM members m JOIN events e ON e.id = m.event_id
         WHERE m.user_id = ?1 ORDER BY e.created_at DESC, e.id DESC`,
      )
      .bind(userId),
    db.prepare(USER_EVENTS_NETS_SQL).bind(userId),
    db
      .prepare(
        `SELECT DISTINCT ${USER_COLUMNS} FROM members m JOIN users u ON u.id = m.user_id
         WHERE m.event_id IN (SELECT event_id FROM members WHERE user_id = ?1)`,
      )
      .bind(userId),
  ]);
  const netsByEvent = new Map<number, Map<number, number>>();
  for (const r of rows<{ event_id: number; user_id: number; net: number }>(netsRes)) {
    let m = netsByEvent.get(r.event_id);
    if (!m) netsByEvent.set(r.event_id, (m = new Map()));
    m.set(r.user_id, Number(r.net) || 0);
  }
  const users = new UserDirectory(rows<UserRow>(usersRes));
  const result: UserEventDebts[] = [];
  for (const e of rows<EventRow>(eventsRes)) {
    const nets = netsByEvent.get(e.id) ?? new Map<number, number>();
    const net = nets.get(userId) ?? 0;
    if (net === 0) continue;
    const item: UserEventDebts = { eventId: e.id, title: e.title, currency: e.currency, net, owes: [], owedBy: [] };
    for (const t of minimizeTransfers(nets)) {
      if (t.from === userId) item.owes.push({ toUser: users.get(t.to), amount: t.amount });
      else if (t.to === userId) item.owedBy.push({ fromUser: users.get(t.from), amount: t.amount });
    }
    result.push(item);
  }
  return result;
}

/**
 * Debtors (net < 0) not reminded for that event within `remindEveryDays` days and without a
 * pending settlement there. Never / least recently reminded first (then event id, user id), so
 * rows that keep failing cannot starve others; at most `limit` rows (one query).
 */
export async function findDebtorsToRemind(
  deps: Deps,
  now: Date | number,
  remindEveryDays: number,
  limit = 50,
): Promise<DebtReminder[]> {
  const nowMs = typeof now === "number" ? now : now.getTime();
  const threshold = nowMs - remindEveryDays * 24 * 60 * 60 * 1000;
  const res = await deps.db
    .prepare(
      `WITH nets AS (
         SELECT event_id, user_id, SUM(v) AS net FROM (
           SELECT event_id, payer_id AS user_id, amount AS v FROM expenses
           UNION ALL SELECT x.event_id, s.user_id, -s.amount FROM expense_shares s
                     JOIN expenses x ON x.id = s.expense_id
           UNION ALL SELECT event_id, from_id, amount FROM settlements WHERE status = 'confirmed'
           UNION ALL SELECT event_id, to_id, -amount FROM settlements WHERE status = 'confirmed'
         ) GROUP BY event_id, user_id HAVING SUM(v) < 0
       )
       SELECT n.event_id, e.title, e.currency, n.user_id, -n.net AS amount
       FROM nets n
       JOIN events e ON e.id = n.event_id
       JOIN members m ON m.event_id = n.event_id AND m.user_id = n.user_id
       LEFT JOIN reminders r ON r.event_id = n.event_id AND r.user_id = n.user_id
       WHERE (r.last_sent_at IS NULL OR r.last_sent_at <= ?1)
         AND NOT EXISTS (SELECT 1 FROM settlements p WHERE p.event_id = n.event_id
                         AND p.from_id = n.user_id AND p.status = 'pending')
       ORDER BY COALESCE(r.last_sent_at, 0), n.event_id, n.user_id
       LIMIT ?2`,
    )
    .bind(threshold, Math.max(0, Math.floor(limit)))
    .all<{ event_id: number; title: string; currency: string; user_id: number; amount: number }>();
  return res.results.map((r) => ({
    eventId: r.event_id,
    eventTitle: r.title,
    currency: r.currency,
    userId: r.user_id,
    amount: Number(r.amount),
  }));
}

const MARK_REMINDED_SQL = `INSERT INTO reminders (event_id, user_id, last_sent_at) VALUES (?1, ?2, ?3)
  ON CONFLICT (event_id, user_id) DO UPDATE SET last_sent_at = excluded.last_sent_at`;

/** Remember that a reminder was sent (404 if the event or user does not exist). */
export async function markReminded(
  deps: Deps,
  eventId: number,
  userId: number,
  now: Date | number = Date.now(),
): Promise<void> {
  const nowMs = typeof now === "number" ? now : now.getTime();
  try {
    await deps.db.prepare(MARK_REMINDED_SQL).bind(eventId, userId, nowMs).run();
  } catch (err) {
    if (isForeignKeyViolation(err)) throw new NotFoundError("Событие или пользователь не найдены");
    throw err;
  }
}

/** Batch version of markReminded: one D1 round trip for the whole cron run. */
export async function markRemindedMany(
  deps: Deps,
  items: readonly { eventId: number; userId: number }[],
  now: Date | number = Date.now(),
): Promise<void> {
  if (items.length === 0) return;
  const nowMs = typeof now === "number" ? now : now.getTime();
  const stmt = deps.db.prepare(MARK_REMINDED_SQL);
  await deps.db.batch(items.map((i) => stmt.bind(i.eventId, i.userId, nowMs)));
}

export { formatMoney } from "./money";
