"""Business logic. Plain async functions taking an AsyncSession; reused by the API and the bot.

Mutating functions commit themselves and send notifications after a successful commit.
Errors are raised as ServiceError subclasses with Russian user-facing messages.
"""

from __future__ import annotations

import html
import secrets
import string
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from sqlalchemy import func, select, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError

from app.money import CURRENCIES, format_money
from app.models import Event, Expense, ExpenseShare, Member, Reminder, Settlement, User, utcnow
from app.notifier import notify

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

__all__ = [
    "CURRENCIES", "MAX_AMOUNT", "format_money",
    "ServiceError", "BadRequestError", "ForbiddenError", "NotFoundError",
    "EventSummary", "EventDetail", "ShareView", "ExpenseView", "BalanceView", "TransferView",
    "EventBalances", "SettlementView", "UserEventDebts", "DebtReminder",
    "split_equally", "minimize_transfers",
    "upsert_user", "get_user", "create_event", "get_event", "is_member", "require_member",
    "get_members", "get_event_detail", "join_by_invite_code", "list_user_events",
    "add_expense", "list_expenses", "delete_expense",
    "compute_nets", "get_event_balances", "debt_to",
    "create_settlement", "list_settlements", "confirm_settlement", "reject_settlement",
    "get_user_debts_summary", "find_debtors_to_remind", "mark_reminded",
]

MAX_AMOUNT = 100_000_000_00  # minor units
TITLE_MAX_LEN = 64
DESCRIPTION_MAX_LEN = 100
INVITE_CODE_LEN = 10
INVITE_CODE_ALPHABET = string.ascii_letters + string.digits + "-_"
MAX_PARTICIPANTS = 200


# ---------------------------------------------------------------- errors


class ServiceError(Exception):
    status_code = 400

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class BadRequestError(ServiceError):
    status_code = 400


class ForbiddenError(ServiceError):
    status_code = 403


class NotFoundError(ServiceError):
    status_code = 404


# ---------------------------------------------------------------- views


@dataclass
class EventSummary:
    id: int
    title: str
    currency: str
    members_count: int
    my_net: int


@dataclass
class EventDetail:
    event: Event
    members: list[User]
    my_net: int


@dataclass
class ShareView:
    user: User
    amount: int


@dataclass
class ExpenseView:
    id: int
    event_id: int
    payer: User
    amount: int
    description: str
    created_at: datetime
    created_by: int
    shares: list[ShareView]


@dataclass
class BalanceView:
    user: User
    net: int


@dataclass
class TransferView:
    from_user: User
    to_user: User
    amount: int


@dataclass
class EventBalances:
    balances: list[BalanceView]
    transfers: list[TransferView]


@dataclass
class SettlementView:
    id: int
    event_id: int
    from_user: User
    to_user: User
    amount: int
    status: str
    created_at: datetime
    resolved_at: datetime | None


@dataclass
class UserEventDebts:
    """User's position in one event: net and the concrete transfers involving the user."""

    event_id: int
    title: str
    currency: str
    net: int
    owes: list[TransferView] = field(default_factory=list)  # user -> others
    owed_by: list[TransferView] = field(default_factory=list)  # others -> user


@dataclass
class DebtReminder:
    event_id: int
    event_title: str
    currency: str
    user_id: int
    amount: int  # how much the user owes (positive)


# ---------------------------------------------------------------- pure math


def split_equally(amount: int, participant_ids: list[int]) -> dict[int, int]:
    """Split amount equally; remainder units go one each to the lowest user ids."""
    ids = sorted(set(participant_ids))
    if not ids:
        raise ValueError("participants must not be empty")
    base, remainder = divmod(amount, len(ids))
    return {uid: base + (1 if i < remainder else 0) for i, uid in enumerate(ids)}


def minimize_transfers(nets: dict[int, int]) -> list[tuple[int, int, int]]:
    """Greedy: repeatedly match the largest debtor with the largest creditor.

    Returns (from_id, to_id, amount) tuples. Ties are broken by lower user id.
    """
    debtors = {uid: -net for uid, net in nets.items() if net < 0}
    creditors = {uid: net for uid, net in nets.items() if net > 0}
    transfers: list[tuple[int, int, int]] = []
    while debtors and creditors:
        debtor = min(debtors, key=lambda u: (-debtors[u], u))
        creditor = min(creditors, key=lambda u: (-creditors[u], u))
        amount = min(debtors[debtor], creditors[creditor])
        transfers.append((debtor, creditor, amount))
        debtors[debtor] -= amount
        creditors[creditor] -= amount
        if debtors[debtor] == 0:
            del debtors[debtor]
        if creditors[creditor] == 0:
            del creditors[creditor]
    return transfers


# ---------------------------------------------------------------- validation helpers


def _clean_text(value: str, max_len: int, what: str) -> str:
    if not isinstance(value, str):
        raise BadRequestError(f"Поле «{what}» должно быть строкой")
    text = " ".join(value.split())  # collapse whitespace / newlines
    if not text:
        raise BadRequestError(f"Поле «{what}» не может быть пустым")
    if len(text) > max_len:
        raise BadRequestError(f"Поле «{what}» слишком длинное (максимум {max_len} символов)")
    return text


def _check_amount(amount: int) -> int:
    if not isinstance(amount, int) or isinstance(amount, bool):
        raise BadRequestError("Сумма должна быть целым числом")
    if amount <= 0:
        raise BadRequestError("Сумма должна быть больше нуля")
    if amount > MAX_AMOUNT:
        raise BadRequestError("Сумма слишком большая")
    return amount


def _check_currency(currency: str | None) -> str:
    code = (currency or "RUB").strip().upper()
    if code not in CURRENCIES:
        raise BadRequestError("Неподдерживаемая валюта. Доступны: " + ", ".join(CURRENCIES))
    return code


def _name(user: User | None) -> str:
    return html.escape(user.display_name) if user else "Кто-то"


def _to_naive_utc(moment: datetime) -> datetime:
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc).replace(tzinfo=None)
    return moment


# ---------------------------------------------------------------- users


async def upsert_user(
    session: AsyncSession,
    user_id: int,
    first_name: str,
    last_name: str | None = None,
    username: str | None = None,
) -> User:
    """Insert or update a Telegram user; commits."""
    values = {
        "first_name": (first_name or "")[:128],
        "last_name": last_name[:128] if last_name else None,
        "username": username[:64] if username else None,
    }
    stmt = sqlite_insert(User).values(id=user_id, created_at=utcnow(), **values)
    stmt = stmt.on_conflict_do_update(index_elements=[User.id], set_=values)
    await session.execute(stmt)
    await session.commit()
    user = await session.get(User, user_id, populate_existing=True)
    assert user is not None
    return user


async def get_user(session: AsyncSession, user_id: int) -> User | None:
    return await session.get(User, user_id)


async def _users_by_ids(session: AsyncSession, ids: set[int]) -> dict[int, User]:
    if not ids:
        return {}
    rows = await session.scalars(select(User).where(User.id.in_(ids)))
    return {u.id: u for u in rows}


# ---------------------------------------------------------------- events & members


async def _new_invite_code(session: AsyncSession) -> str:
    for _ in range(10):
        code = "".join(secrets.choice(INVITE_CODE_ALPHABET) for _ in range(INVITE_CODE_LEN))
        exists = await session.scalar(select(Event.id).where(Event.invite_code == code))
        if exists is None:
            return code
    raise RuntimeError("could not generate a unique invite code")


async def create_event(
    session: AsyncSession, owner_id: int, title: str, currency: str | None = "RUB"
) -> Event:
    """Create an event; the owner becomes its first member. Commits."""
    title = _clean_text(title, TITLE_MAX_LEN, "название")
    currency = _check_currency(currency)
    if await session.get(User, owner_id) is None:
        raise NotFoundError("Пользователь не найден")
    event = Event(
        title=title,
        currency=currency,
        invite_code=await _new_invite_code(session),
        owner_id=owner_id,
    )
    session.add(event)
    await session.flush()
    session.add(Member(event_id=event.id, user_id=owner_id))
    await session.commit()
    return event


async def get_event(session: AsyncSession, event_id: int) -> Event:
    event = await session.get(Event, event_id)
    if event is None:
        raise NotFoundError("Событие не найдено")
    return event


async def is_member(session: AsyncSession, event_id: int, user_id: int) -> bool:
    return await session.get(Member, (event_id, user_id)) is not None


async def require_member(session: AsyncSession, event_id: int, user_id: int) -> Event:
    """Return the event or raise 404 (unknown) / 403 (not a member)."""
    event = await get_event(session, event_id)
    if not await is_member(session, event_id, user_id):
        raise ForbiddenError("Вы не участник этого события")
    return event


async def _member_ids(session: AsyncSession, event_id: int) -> list[int]:
    rows = await session.scalars(
        select(Member.user_id)
        .where(Member.event_id == event_id)
        .order_by(Member.joined_at, Member.user_id)
    )
    return list(rows)


async def get_members(session: AsyncSession, event_id: int) -> list[User]:
    """Members in join order."""
    rows = await session.scalars(
        select(User)
        .join(Member, Member.user_id == User.id)
        .where(Member.event_id == event_id)
        .order_by(Member.joined_at, Member.user_id)
    )
    return list(rows)


async def get_event_detail(session: AsyncSession, event_id: int, user_id: int) -> EventDetail:
    event = await require_member(session, event_id, user_id)
    members = await get_members(session, event_id)
    nets = await compute_nets(session, event_id)
    return EventDetail(event=event, members=members, my_net=nets.get(user_id, 0))


async def join_by_invite_code(
    session: AsyncSession, user_id: int, invite_code: str
) -> tuple[Event, bool]:
    """Join an event by invite code. Idempotent. Returns (event, joined_now). Commits."""
    code = (invite_code or "").strip()
    if code.startswith("join_"):
        code = code[len("join_"):]
    if not code or len(code) > 32 or any(c not in INVITE_CODE_ALPHABET for c in code):
        raise NotFoundError("Приглашение не найдено")
    event = await session.scalar(select(Event).where(Event.invite_code == code))
    if event is None:
        raise NotFoundError("Приглашение не найдено")
    user = await session.get(User, user_id)
    if user is None:
        raise NotFoundError("Пользователь не найден")

    stmt = (
        sqlite_insert(Member)
        .values(event_id=event.id, user_id=user_id, joined_at=utcnow())
        .on_conflict_do_nothing()
    )
    result = await session.execute(stmt)
    await session.commit()
    joined_now = result.rowcount == 1

    if joined_now:
        others = [uid for uid in await _member_ids(session, event.id) if uid != user_id]
        text = (
            f"<b>{_name(user)}</b> присоединился(-ась) к событию "
            f"«{html.escape(event.title)}»"
        )
        for uid in others:
            await notify(uid, text, {"event_id": event.id})
    return event, joined_now


async def list_user_events(session: AsyncSession, user_id: int) -> list[EventSummary]:
    """User's events, newest first, with members count and the user's net."""
    events = list(
        await session.scalars(
            select(Event)
            .join(Member, Member.event_id == Event.id)
            .where(Member.user_id == user_id)
            .order_by(Event.created_at.desc(), Event.id.desc())
        )
    )
    nets = await _nets_for_events(session, [e.id for e in events])
    return [
        EventSummary(
            id=e.id,
            title=e.title,
            currency=e.currency,
            members_count=len(nets.get(e.id, {})),
            my_net=nets.get(e.id, {}).get(user_id, 0),
        )
        for e in events
    ]


# ---------------------------------------------------------------- expenses


def _expense_view(expense: Expense, users: dict[int, User]) -> ExpenseView:
    return ExpenseView(
        id=expense.id,
        event_id=expense.event_id,
        payer=users[expense.payer_id],
        amount=expense.amount,
        description=expense.description,
        created_at=expense.created_at,
        created_by=expense.created_by,
        shares=[ShareView(user=users[s.user_id], amount=s.amount) for s in expense.shares],
    )


async def add_expense(
    session: AsyncSession,
    event_id: int,
    actor_id: int,
    amount: int,
    description: str,
    payer_id: int,
    participant_ids: list[int],
) -> ExpenseView:
    """Add an expense split equally between participants. Commits and notifies."""
    event = await require_member(session, event_id, actor_id)
    amount = _check_amount(amount)
    description = _clean_text(description, DESCRIPTION_MAX_LEN, "описание")
    if not participant_ids:
        raise BadRequestError("Выберите хотя бы одного участника")
    if len(participant_ids) > MAX_PARTICIPANTS:
        raise BadRequestError("Слишком много участников")
    if len(set(participant_ids)) != len(participant_ids):
        raise BadRequestError("Участники не должны повторяться")

    members = set(await _member_ids(session, event_id))
    if payer_id not in members:
        raise BadRequestError("Плательщик должен быть участником события")
    if not set(participant_ids) <= members:
        raise BadRequestError("Все участники траты должны быть участниками события")

    shares = split_equally(amount, participant_ids)
    expense = Expense(
        event_id=event_id,
        payer_id=payer_id,
        amount=amount,
        description=description,
        created_by=actor_id,
        shares=[ExpenseShare(user_id=uid, amount=share) for uid, share in shares.items()],
    )
    session.add(expense)
    await session.commit()

    users = await _users_by_ids(session, set(shares) | {payer_id, actor_id})
    view = _expense_view(expense, users)

    recipients = (set(shares) | {payer_id}) - {actor_id}
    head = (
        f"<b>{_name(users.get(actor_id))}</b> добавил(а) трату в «{html.escape(event.title)}»:\n"
        f"{html.escape(description)} — <b>{format_money(amount, event.currency)}</b>\n"
        f"Заплатил(а): {_name(users.get(payer_id))}"
    )
    for uid in sorted(recipients):
        text = head
        if uid in shares:
            text += f"\nВаша доля: <b>{format_money(shares[uid], event.currency)}</b>"
        await notify(uid, text, {"event_id": event_id})
    return view


async def list_expenses(session: AsyncSession, event_id: int, user_id: int) -> list[ExpenseView]:
    """Expenses of an event, newest first."""
    await require_member(session, event_id, user_id)
    expenses = list(
        await session.scalars(
            select(Expense)
            .where(Expense.event_id == event_id)
            .order_by(Expense.created_at.desc(), Expense.id.desc())
        )
    )
    ids: set[int] = set()
    for e in expenses:
        ids.add(e.payer_id)
        ids.update(s.user_id for s in e.shares)
    users = await _users_by_ids(session, ids)
    return [_expense_view(e, users) for e in expenses]


async def delete_expense(session: AsyncSession, expense_id: int, actor_id: int) -> None:
    """Delete an expense; only its creator or payer may do it. Commits."""
    expense = await session.get(Expense, expense_id)
    if expense is None:
        raise NotFoundError("Трата не найдена")
    await require_member(session, expense.event_id, actor_id)
    if actor_id not in (expense.created_by, expense.payer_id):
        raise ForbiddenError("Удалить трату может только тот, кто её добавил или оплатил")
    await session.delete(expense)
    await session.commit()


# ---------------------------------------------------------------- balances


async def _nets_for_events(
    session: AsyncSession, event_ids: list[int] | None
) -> dict[int, dict[int, int]]:
    """{event_id: {user_id: net}} for given events (all events if None). Members always present."""
    if event_ids is not None and not event_ids:
        return {}

    def scoped(stmt, column):
        return stmt if event_ids is None else stmt.where(column.in_(event_ids))

    nets: dict[int, dict[int, int]] = defaultdict(dict)
    for ev_id, uid in await session.execute(
        scoped(select(Member.event_id, Member.user_id), Member.event_id)
    ):
        nets[ev_id][uid] = 0

    def add(rows, sign: int) -> None:
        for ev_id, uid, total in rows:
            nets[ev_id][uid] = nets[ev_id].get(uid, 0) + sign * int(total or 0)

    add(
        await session.execute(
            scoped(
                select(Expense.event_id, Expense.payer_id, func.sum(Expense.amount)),
                Expense.event_id,
            ).group_by(Expense.event_id, Expense.payer_id)
        ),
        +1,
    )
    add(
        await session.execute(
            scoped(
                select(Expense.event_id, ExpenseShare.user_id, func.sum(ExpenseShare.amount))
                .join(Expense, Expense.id == ExpenseShare.expense_id),
                Expense.event_id,
            ).group_by(Expense.event_id, ExpenseShare.user_id)
        ),
        -1,
    )
    confirmed = Settlement.status == "confirmed"
    add(
        await session.execute(
            scoped(
                select(Settlement.event_id, Settlement.from_id, func.sum(Settlement.amount))
                .where(confirmed),
                Settlement.event_id,
            ).group_by(Settlement.event_id, Settlement.from_id)
        ),
        +1,
    )
    add(
        await session.execute(
            scoped(
                select(Settlement.event_id, Settlement.to_id, func.sum(Settlement.amount))
                .where(confirmed),
                Settlement.event_id,
            ).group_by(Settlement.event_id, Settlement.to_id)
        ),
        -1,
    )
    return dict(nets)


async def compute_nets(session: AsyncSession, event_id: int) -> dict[int, int]:
    """{user_id: net} for one event (no permission check). net > 0: others owe the user."""
    return (await _nets_for_events(session, [event_id])).get(event_id, {})


async def get_event_balances(session: AsyncSession, event_id: int, user_id: int) -> EventBalances:
    await require_member(session, event_id, user_id)
    nets = await compute_nets(session, event_id)
    users = await _users_by_ids(session, set(nets))
    balances = [
        BalanceView(user=users[uid], net=net)
        for uid, net in sorted(nets.items(), key=lambda kv: (-kv[1], kv[0]))
    ]
    transfers = [
        TransferView(from_user=users[f], to_user=users[t], amount=a)
        for f, t, a in minimize_transfers(nets)
    ]
    return EventBalances(balances=balances, transfers=transfers)


# ---------------------------------------------------------------- settlements


def _settlement_view(s: Settlement, users: dict[int, User]) -> SettlementView:
    return SettlementView(
        id=s.id,
        event_id=s.event_id,
        from_user=users[s.from_id],
        to_user=users[s.to_id],
        amount=s.amount,
        status=s.status,
        created_at=s.created_at,
        resolved_at=s.resolved_at,
    )


PENDING_EXISTS_MESSAGE = "Предыдущий возврат ещё ждёт подтверждения"


async def debt_to(session: AsyncSession, event_id: int, from_id: int, to_id: int) -> int:
    """Amount from_id should pay to_id according to the current minimal transfers (0 if none)."""
    nets = await compute_nets(session, event_id)
    return sum(a for f, t, a in minimize_transfers(nets) if f == from_id and t == to_id)


async def create_settlement(
    session: AsyncSession, event_id: int, from_id: int, to_id: int, amount: int
) -> SettlementView:
    """Record "I paid back" from from_id to to_id (pending until recipient confirms)."""
    event = await require_member(session, event_id, from_id)
    amount = _check_amount(amount)
    if to_id == from_id:
        raise BadRequestError("Нельзя вернуть деньги самому себе")
    if not await is_member(session, event_id, to_id):
        raise BadRequestError("Получатель должен быть участником события")

    pending = int(
        await session.scalar(
            select(func.coalesce(func.sum(Settlement.amount), 0)).where(
                Settlement.event_id == event_id,
                Settlement.from_id == from_id,
                Settlement.to_id == to_id,
                Settlement.status == "pending",
            )
        )
        or 0
    )
    if pending > 0:
        raise BadRequestError(PENDING_EXISTS_MESSAGE)
    if amount > await debt_to(session, event_id, from_id, to_id) - pending:
        raise BadRequestError("Сумма больше вашего долга этому участнику")

    settlement = Settlement(
        event_id=event_id, from_id=from_id, to_id=to_id, amount=amount, status="pending"
    )
    session.add(settlement)
    try:
        await session.commit()
    except IntegrityError:
        # Partial unique index: a concurrent request created a pending settlement first.
        await session.rollback()
        raise BadRequestError(PENDING_EXISTS_MESSAGE) from None

    users = await _users_by_ids(session, {from_id, to_id})
    text = (
        f"<b>{_name(users.get(from_id))}</b> отметил(а), что вернул(а) вам "
        f"<b>{format_money(amount, event.currency)}</b> в «{html.escape(event.title)}» — подтвердите"
    )
    await notify(to_id, text, {"event_id": event_id})
    return _settlement_view(settlement, users)


async def list_settlements(
    session: AsyncSession, event_id: int, user_id: int
) -> list[SettlementView]:
    """Settlements of an event, newest first."""
    await require_member(session, event_id, user_id)
    rows = list(
        await session.scalars(
            select(Settlement)
            .where(Settlement.event_id == event_id)
            .order_by(Settlement.created_at.desc(), Settlement.id.desc())
        )
    )
    users = await _users_by_ids(session, {s.from_id for s in rows} | {s.to_id for s in rows})
    return [_settlement_view(s, users) for s in rows]


async def _resolve_settlement(
    session: AsyncSession, settlement_id: int, actor_id: int, confirm: bool
) -> SettlementView:
    settlement = await session.get(Settlement, settlement_id)
    if settlement is None:
        raise NotFoundError("Перевод не найден")
    event = await require_member(session, settlement.event_id, actor_id)
    if settlement.to_id != actor_id:
        raise ForbiddenError("Подтвердить или отклонить перевод может только получатель")
    # Conditional update: protects against concurrent confirm/reject of the same settlement.
    result = await session.execute(
        update(Settlement)
        .where(Settlement.id == settlement_id, Settlement.status == "pending")
        .values(status="confirmed" if confirm else "rejected", resolved_at=utcnow())
        .execution_options(synchronize_session=False)
    )
    # Commit even when nothing changed: ends the transaction without expiring loaded objects
    # (a rollback would expire them, breaking later attribute access in async code).
    await session.commit()
    if result.rowcount != 1:
        raise BadRequestError("Этот возврат уже обработан")
    await session.refresh(settlement)

    users = await _users_by_ids(session, {settlement.from_id, settlement.to_id})
    money = format_money(settlement.amount, event.currency)
    title = html.escape(event.title)
    recipient = _name(users.get(settlement.to_id))
    if confirm:
        text = f"<b>{recipient}</b> подтвердил(а) получение <b>{money}</b> в «{title}»"
    else:
        text = f"<b>{recipient}</b> отклонил(а) ваш перевод <b>{money}</b> в «{title}»"
    await notify(settlement.from_id, text, {"event_id": event.id})
    return _settlement_view(settlement, users)


async def confirm_settlement(
    session: AsyncSession, settlement_id: int, actor_id: int
) -> SettlementView:
    return await _resolve_settlement(session, settlement_id, actor_id, confirm=True)


async def reject_settlement(
    session: AsyncSession, settlement_id: int, actor_id: int
) -> SettlementView:
    return await _resolve_settlement(session, settlement_id, actor_id, confirm=False)


# ---------------------------------------------------------------- bot helpers


async def get_user_debts_summary(session: AsyncSession, user_id: int) -> list[UserEventDebts]:
    """Events where the user's net is non-zero, with who the user owes / who owes the user."""
    events = list(
        await session.scalars(
            select(Event)
            .join(Member, Member.event_id == Event.id)
            .where(Member.user_id == user_id)
            .order_by(Event.created_at.desc(), Event.id.desc())
        )
    )
    nets_by_event = await _nets_for_events(session, [e.id for e in events])
    summaries: list[UserEventDebts] = []
    needed: set[int] = set()
    raw: list[tuple[Event, int, list[tuple[int, int, int]]]] = []
    for event in events:
        nets = nets_by_event.get(event.id, {})
        my_net = nets.get(user_id, 0)
        if my_net == 0:
            continue
        mine = [t for t in minimize_transfers(nets) if user_id in (t[0], t[1])]
        raw.append((event, my_net, mine))
        for f, t, _ in mine:
            needed.update((f, t))
    users = await _users_by_ids(session, needed)
    for event, my_net, mine in raw:
        item = UserEventDebts(event_id=event.id, title=event.title, currency=event.currency, net=my_net)
        for f, t, amount in mine:
            view = TransferView(from_user=users[f], to_user=users[t], amount=amount)
            (item.owes if f == user_id else item.owed_by).append(view)
        summaries.append(item)
    return summaries


async def find_debtors_to_remind(
    session: AsyncSession, now: datetime, remind_every_days: int
) -> list[DebtReminder]:
    """Debtors (net < 0) not reminded in the last `remind_every_days` days for that event."""
    now = _to_naive_utc(now)
    threshold = now - timedelta(days=remind_every_days)
    nets_by_event = await _nets_for_events(session, None)
    if not nets_by_event:
        return []
    last_sent = {
        (r.event_id, r.user_id): r.last_sent_at
        for r in await session.scalars(select(Reminder))
    }
    events = {
        e.id: e
        for e in await session.scalars(select(Event).where(Event.id.in_(list(nets_by_event))))
    }
    # A debtor who already reported a payback waits for confirmation; do not nag them.
    pending_rows = await session.execute(
        select(Settlement.event_id, Settlement.from_id)
        .where(Settlement.status == "pending")
        .distinct()
    )
    has_pending = {(ev_id, uid) for ev_id, uid in pending_rows}
    result: list[DebtReminder] = []
    for event_id in sorted(nets_by_event):
        event = events.get(event_id)
        if event is None:
            continue
        for uid, net in sorted(nets_by_event[event_id].items()):
            if net >= 0 or (event_id, uid) in has_pending:
                continue
            sent = last_sent.get((event_id, uid))
            if sent is not None and sent > threshold:
                continue
            result.append(
                DebtReminder(
                    event_id=event_id,
                    event_title=event.title,
                    currency=event.currency,
                    user_id=uid,
                    amount=-net,
                )
            )
    return result


async def mark_reminded(
    session: AsyncSession, event_id: int, user_id: int, now: datetime | None = None
) -> None:
    """Remember that a reminder was sent. Commits."""
    moment = _to_naive_utc(now) if now else utcnow()
    stmt = sqlite_insert(Reminder).values(event_id=event_id, user_id=user_id, last_sent_at=moment)
    stmt = stmt.on_conflict_do_update(
        index_elements=[Reminder.event_id, Reminder.user_id], set_={"last_sent_at": moment}
    )
    try:
        await session.execute(stmt)
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise NotFoundError("Событие или пользователь не найдены") from None
