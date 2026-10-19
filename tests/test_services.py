from datetime import datetime, timedelta, timezone

import pytest

from app import services as s
from app.notifier import drain
from tests.conftest import ALICE, BOB, CAROL, MALLORY


async def _users(session):
    for u in (ALICE, BOB, CAROL, MALLORY):
        await s.upsert_user(session, u["id"], u["first_name"], u.get("last_name"), u.get("username"))


async def _event_with_three(session):
    await _users(session)
    event = await s.create_event(session, ALICE["id"], "Поездка", "RUB")
    for u in (BOB, CAROL):
        await s.join_by_invite_code(session, u["id"], event.invite_code)
    return event


async def test_upsert_updates_fields(session):
    await s.upsert_user(session, 1, "Old", None, None)
    user = await s.upsert_user(session, 1, "New", "Name", "nick")
    assert (user.first_name, user.last_name, user.username) == ("New", "Name", "nick")
    assert user.display_name == "New Name"


async def test_create_event_validation(session):
    await _users(session)
    with pytest.raises(s.BadRequestError):
        await s.create_event(session, ALICE["id"], "   ", "RUB")
    with pytest.raises(s.BadRequestError):
        await s.create_event(session, ALICE["id"], "x" * 65, "RUB")
    with pytest.raises(s.BadRequestError):
        await s.create_event(session, ALICE["id"], "Ok", "BTC")
    event = await s.create_event(session, ALICE["id"], "  Дача  ", "usd")
    assert event.title == "Дача" and event.currency == "USD"
    assert len(event.invite_code) == 10


async def test_join_idempotent_and_notifies(session, sent):
    event = await _event_with_three(session)
    joined_again = await s.join_by_invite_code(session, BOB["id"], "join_" + event.invite_code)
    assert joined_again[1] is False
    # Bob's join notified Alice; Carol's join notified Alice and Bob.
    await drain(5)
    assert sorted(uid for uid, _, _ in sent) == [ALICE["id"], ALICE["id"], BOB["id"]]
    assert all(extra == {"event_id": event.id} for _, _, extra in sent)
    with pytest.raises(s.NotFoundError):
        await s.join_by_invite_code(session, BOB["id"], "nope'; DROP TABLE users;--")


async def test_balances_sum_to_zero(session):
    event = await _event_with_three(session)
    a, b, c = ALICE["id"], BOB["id"], CAROL["id"]
    await s.add_expense(session, event.id, a, 1000, "Еда", a, [a, b, c])
    await s.add_expense(session, event.id, b, 777, "Такси", b, [b, c])
    await s.add_expense(session, event.id, c, 1, "Жвачка", c, [a, b, c])
    nets = await s.compute_nets(session, event.id)
    assert sum(nets.values()) == 0
    # Alice: paid 1000, share 334 + 1 (lowest id gets the remainder kopeck of 1)
    assert nets[a] == 1000 - 334 - 1
    balances = await s.get_event_balances(session, event.id, a)
    paid_back = {u: 0 for u in nets}
    for t in balances.transfers:
        paid_back[t.from_user.id] += t.amount
        paid_back[t.to_user.id] -= t.amount
    assert all(nets[u] + paid_back[u] == 0 for u in nets)


async def test_expense_validation(session):
    event = await _event_with_three(session)
    a, b = ALICE["id"], BOB["id"]
    cases = [
        dict(amount=0, description="x", payer_id=a, participant_ids=[a]),
        dict(amount=s.MAX_AMOUNT + 1, description="x", payer_id=a, participant_ids=[a]),
        dict(amount=100, description="", payer_id=a, participant_ids=[a]),
        dict(amount=100, description="x" * 101, payer_id=a, participant_ids=[a]),
        dict(amount=100, description="x", payer_id=a, participant_ids=[]),
        dict(amount=100, description="x", payer_id=a, participant_ids=[a, a]),
        dict(amount=100, description="x", payer_id=MALLORY["id"], participant_ids=[a]),
        dict(amount=100, description="x", payer_id=a, participant_ids=[a, MALLORY["id"]]),
    ]
    for case in cases:
        with pytest.raises(s.BadRequestError):
            await s.add_expense(session, event.id, b, **case)
    with pytest.raises(s.ForbiddenError):
        await s.add_expense(session, event.id, MALLORY["id"], 100, "x", a, [a])
    with pytest.raises(s.NotFoundError):
        await s.add_expense(session, 999, a, 100, "x", a, [a])


async def test_expense_notifications(session, sent):
    event = await _event_with_three(session)
    await drain(5)
    sent.clear()
    a, b, c = ALICE["id"], BOB["id"], CAROL["id"]
    await s.add_expense(session, event.id, a, 150000, "Ужин <b>", b, [a, c])
    assert sent == []  # delivery happens in the background, the call does not wait for it
    await drain(5)
    by_user = {uid: text for uid, text, _ in sent}
    assert set(by_user) == {b, c}  # payer + participants, minus actor
    assert "1 500 ₽" in by_user[c] and "Ваша доля: <b>750 ₽</b>" in by_user[c]
    assert "Ваша доля" not in by_user[b]
    assert "&lt;b&gt;" in by_user[c]  # user text is HTML-escaped


async def test_delete_permissions(session):
    event = await _event_with_three(session)
    a, b, c = ALICE["id"], BOB["id"], CAROL["id"]
    exp = await s.add_expense(session, event.id, a, 900, "Пицца", b, [a, b, c])
    with pytest.raises(s.ForbiddenError):
        await s.delete_expense(session, exp.id, c)  # neither creator nor payer
    with pytest.raises(s.ForbiddenError):
        await s.delete_expense(session, exp.id, MALLORY["id"])
    await s.delete_expense(session, exp.id, b)  # payer may delete
    assert await s.list_expenses(session, event.id, a) == []
    exp2 = await s.add_expense(session, event.id, a, 900, "Пицца", b, [a, b, c])
    await s.delete_expense(session, exp2.id, a)  # creator may delete
    with pytest.raises(s.NotFoundError):
        await s.delete_expense(session, exp2.id, a)
    assert all(v == 0 for v in (await s.compute_nets(session, event.id)).values())


async def test_settlement_flow(session, sent):
    event = await _event_with_three(session)
    a, b, c = ALICE["id"], BOB["id"], CAROL["id"]
    await s.add_expense(session, event.id, a, 3000, "Билеты", a, [a, b, c])
    assert (await s.compute_nets(session, event.id))[b] == -1000

    await drain(5)
    sent.clear()
    st = await s.create_settlement(session, event.id, b, a, 1000)
    assert st.status == "pending"
    await drain(5)
    assert [uid for uid, _, _ in sent] == [a]
    assert "подтвердите" in sent[0][1]
    # Pending settlement does not change balances.
    assert (await s.compute_nets(session, event.id))[b] == -1000

    with pytest.raises(s.ForbiddenError):
        await s.confirm_settlement(session, st.id, b)  # sender cannot confirm
    with pytest.raises(s.ForbiddenError):
        await s.confirm_settlement(session, st.id, c)
    with pytest.raises(s.ForbiddenError):
        await s.confirm_settlement(session, st.id, MALLORY["id"])

    await drain(5)
    sent.clear()
    done = await s.confirm_settlement(session, st.id, a)
    assert done.status == "confirmed" and done.resolved_at is not None
    await drain(5)
    assert [uid for uid, _, _ in sent] == [b]
    nets = await s.compute_nets(session, event.id)
    assert nets == {a: 1000, b: 0, c: -1000}
    with pytest.raises(s.BadRequestError):
        await s.reject_settlement(session, st.id, a)  # already resolved

    st2 = await s.create_settlement(session, event.id, c, a, 500)
    rejected = await s.reject_settlement(session, st2.id, a)
    assert rejected.status == "rejected"
    assert (await s.compute_nets(session, event.id))[c] == -1000
    assert [x.id for x in await s.list_settlements(session, event.id, c)] == [st2.id, st.id]


async def test_settlement_validation(session):
    event = await _event_with_three(session)
    a, b = ALICE["id"], BOB["id"]
    with pytest.raises(s.BadRequestError):
        await s.create_settlement(session, event.id, a, a, 100)
    with pytest.raises(s.BadRequestError):
        await s.create_settlement(session, event.id, a, MALLORY["id"], 100)
    with pytest.raises(s.BadRequestError):
        await s.create_settlement(session, event.id, a, b, -5)
    with pytest.raises(s.ForbiddenError):
        await s.create_settlement(session, event.id, MALLORY["id"], a, 100)


def _msg(exc_info) -> str:
    return exc_info.value.message


async def test_settlement_limited_by_debt(session):
    event = await _event_with_three(session)
    a, b, c = ALICE["id"], BOB["id"], CAROL["id"]
    # No debts yet: nothing to pay back.
    with pytest.raises(s.BadRequestError) as exc:
        await s.create_settlement(session, event.id, b, a, 100)
    assert _msg(exc) == "Сумма больше вашего долга этому участнику"

    await s.add_expense(session, event.id, a, 3000, "Билеты", a, [a, b, c])
    assert await s.debt_to(session, event.id, b, a) == 1000
    with pytest.raises(s.BadRequestError) as exc:
        await s.create_settlement(session, event.id, b, a, 1001)
    assert _msg(exc) == "Сумма больше вашего долга этому участнику"
    with pytest.raises(s.BadRequestError):
        await s.create_settlement(session, event.id, b, c, 1)  # Bob owes Carol nothing
    with pytest.raises(s.BadRequestError):
        await s.create_settlement(session, event.id, a, b, 1)  # creditor cannot "pay back"

    # Partial payback is fine; a second pending one to the same person is not.
    first = await s.create_settlement(session, event.id, b, a, 400)
    with pytest.raises(s.BadRequestError) as exc:
        await s.create_settlement(session, event.id, b, a, 100)
    assert _msg(exc) == "Предыдущий возврат ещё ждёт подтверждения"
    # Other pairs are independent.
    await s.create_settlement(session, event.id, c, a, 1000)

    await s.confirm_settlement(session, first.id, a)
    assert await s.debt_to(session, event.id, b, a) == 600
    with pytest.raises(s.BadRequestError):
        await s.create_settlement(session, event.id, b, a, 601)
    await s.create_settlement(session, event.id, b, a, 600)


async def test_settlement_resolve_race(session, database):
    """Two sessions confirm/reject the same pending settlement: exactly one wins."""
    event = await _event_with_three(session)
    a, b, c = ALICE["id"], BOB["id"], CAROL["id"]
    await s.add_expense(session, event.id, a, 3000, "Билеты", a, [a, b, c])
    st = await s.create_settlement(session, event.id, b, a, 1000)

    from app import db
    from app.models import Settlement

    async with db.session_scope() as s1, db.session_scope() as s2:
        # Both sessions load the settlement while it is still pending.
        assert (await s1.get(Settlement, st.id)).status == "pending"
        assert (await s2.get(Settlement, st.id)).status == "pending"
        await s.confirm_settlement(s1, st.id, a)
        with pytest.raises(s.BadRequestError) as exc:
            await s.reject_settlement(s2, st.id, a)
        assert _msg(exc) == "Этот возврат уже обработан"
    assert (await s.compute_nets(session, event.id))[b] == 0


async def test_debts_summary_and_reminders(session):
    event = await _event_with_three(session)
    a, b, c = ALICE["id"], BOB["id"], CAROL["id"]
    await s.add_expense(session, event.id, a, 3000, "Билеты", a, [a, b, c])

    summary = await s.get_user_debts_summary(session, b)
    assert len(summary) == 1 and summary[0].net == -1000
    assert [(t.to_user.id, t.amount) for t in summary[0].owes] == [(a, 1000)]
    alice = (await s.get_user_debts_summary(session, a))[0]
    assert sorted((t.from_user.id, t.amount) for t in alice.owed_by) == [(b, 1000), (c, 1000)]

    now = datetime.now(timezone.utc)
    due = await s.find_debtors_to_remind(session, now, 3)
    assert [(r.user_id, r.amount, r.event_title) for r in due] == [(b, 1000, "Поездка"), (c, 1000, "Поездка")]

    await s.mark_reminded(session, event.id, b, now)
    due = await s.find_debtors_to_remind(session, now + timedelta(days=1), 3)
    assert [r.user_id for r in due] == [c]
    due = await s.find_debtors_to_remind(session, now + timedelta(days=3, minutes=1), 3)
    assert [r.user_id for r in due] == [b, c]

    # Carol reported a payback that is still pending: she is not reminded.
    st = await s.create_settlement(session, event.id, c, a, 500)
    due = await s.find_debtors_to_remind(session, now + timedelta(days=4), 3)
    assert [r.user_id for r in due] == [b]
    await s.reject_settlement(session, st.id, a)
    due = await s.find_debtors_to_remind(session, now + timedelta(days=4), 3)
    assert [r.user_id for r in due] == [b, c]

    events = await s.list_user_events(session, b)
    assert [(e.title, e.members_count, e.my_net) for e in events] == [("Поездка", 3, -1000)]


async def test_notify_runs_in_background_and_drains():
    import asyncio

    from app import notifier

    delivered: list[int] = []
    gate = asyncio.Event()

    async def slow(user_id, text, extra=None):
        await gate.wait()
        if user_id == 2:
            raise RuntimeError("telegram is down")
        delivered.append(user_id)

    notifier.set_notifier(slow)
    try:
        await notifier.notify(1, "a")
        await notifier.notify(2, "b")  # failure must be swallowed and logged
        assert notifier.pending_count() == 2 and delivered == []
        gate.set()
        await notifier.drain(5)
        assert delivered == [1] and notifier.pending_count() == 0

        gate.clear()
        await notifier.notify(3, "c")
        await notifier.drain(0.05)  # times out: leftover task is cancelled
        assert notifier.pending_count() == 0 and delivered == [1]
    finally:
        notifier.set_notifier(None)


async def test_db_allows_single_pending_per_pair(session):
    from sqlalchemy.exc import IntegrityError

    from app.models import Settlement

    event = await _event_with_three(session)
    a, b = ALICE["id"], BOB["id"]
    session.add(Settlement(event_id=event.id, from_id=b, to_id=a, amount=1, status="pending"))
    await session.commit()
    session.add(Settlement(event_id=event.id, from_id=b, to_id=a, amount=1, status="confirmed"))
    await session.commit()  # non-pending duplicates are fine
    session.add(Settlement(event_id=event.id, from_id=b, to_id=a, amount=2, status="pending"))
    with pytest.raises(IntegrityError):
        await session.commit()
    await session.rollback()
