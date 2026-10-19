"""Exact (custom) split of expenses: services, API and DB migration."""

import sqlite3

import pytest
from sqlalchemy import select

from app import db
from app import services as s
from app.models import Expense
from app.notifier import drain
from tests.conftest import ALICE, BOB, CAROL, MALLORY, headers

A, B, C, M = ALICE["id"], BOB["id"], CAROL["id"], MALLORY["id"]


async def _event_with_three(session):
    for u in (ALICE, BOB, CAROL, MALLORY):
        await s.upsert_user(session, u["id"], u["first_name"], u.get("last_name"), u.get("username"))
    event = await s.create_event(session, A, "Поездка", "RUB")
    for uid in (B, C):
        await s.join_by_invite_code(session, uid, event.invite_code)
    return event


# ---------------------------------------------------------------- services


async def test_exact_split_happy_path(session, sent):
    event = await _event_with_three(session)
    await drain(5)
    sent.clear()
    view = await s.add_expense(
        session, event.id, A, 1000, "Ужин", A, split="exact", shares=[(C, 700), (B, 300)]
    )
    assert view.split == "exact"
    assert [(x.user.id, x.amount) for x in view.shares] == [(B, 300), (C, 700)]
    # Payer without a share is owed the whole amount.
    assert await s.compute_nets(session, event.id) == {A: 1000, B: -300, C: -700}
    balances = await s.get_event_balances(session, event.id, A)
    assert [(t.from_user.id, t.to_user.id, t.amount) for t in balances.transfers] == [
        (C, A, 700),
        (B, A, 300),
    ]

    # Each recipient sees their actual share.
    await drain(5)
    by_user = {uid: text for uid, text, _ in sent}
    assert set(by_user) == {B, C}
    assert "Ваша доля: <b>3 ₽</b>" in by_user[B]
    assert "Ваша доля: <b>7 ₽</b>" in by_user[C]

    # Dict form is accepted too; listing returns the stored mode.
    await s.add_expense(session, event.id, B, 500, "Такси", B, split="exact", shares={A: 250, B: 250})
    assert [x.split for x in await s.list_expenses(session, event.id, A)] == ["exact", "exact"]
    assert await s.compute_nets(session, event.id) == {A: 750, B: -50, C: -700}


async def test_equal_split_is_default(session):
    event = await _event_with_three(session)
    view = await s.add_expense(session, event.id, A, 101, "x", A, [A, B])
    assert view.split == "equal"
    assert [x.amount for x in view.shares] == [51, 50]


@pytest.mark.parametrize(
    "kwargs,message",
    [
        (dict(split="exact", shares=[(A, 600), (B, 300)]),
         "Сумма долей (9 ₽) не совпадает с суммой траты (10 ₽)"),
        (dict(split="exact", shares=[(A, 1000), (B, 0)]),
         "Доля каждого участника должна быть больше нуля"),
        (dict(split="exact", shares=[(A, 1100), (B, -100)]),
         "Доля каждого участника должна быть больше нуля"),
        (dict(split="exact", shares=[(A, 500), (A, 500)]), "Участники не должны повторяться"),
        (dict(split="exact", shares=[]), "Укажите доли участников"),
        (dict(split="exact"), "Укажите доли участников"),
        (dict(split="exact", shares=[(A, 500), (M, 500)]),
         "Все участники траты должны быть участниками события"),
        (dict(split="exact", shares=[(A, 1000)], participant_ids=[A]),
         "При точном делении укажите доли, а не список участников"),
        (dict(participant_ids=[A], shares=[(A, 1000)]), "При равном делении доли не указываются"),
        (dict(split="weird", participant_ids=[A]), "Неизвестный способ деления траты"),
    ],
)
async def test_exact_split_validation(session, kwargs, message):
    event = await _event_with_three(session)
    with pytest.raises(s.BadRequestError) as exc:
        await s.add_expense(session, event.id, A, 1000, "x", A, **kwargs)
    assert exc.value.message == message
    assert await s.list_expenses(session, event.id, A) == []


async def test_exact_split_non_member_actor_forbidden(session):
    event = await _event_with_three(session)
    with pytest.raises(s.ForbiddenError):
        await s.add_expense(session, event.id, M, 100, "x", A, split="exact", shares=[(A, 100)])


# ---------------------------------------------------------------- migration

OLD_SCHEMA = """
CREATE TABLE users (id BIGINT PRIMARY KEY, first_name VARCHAR(128), last_name VARCHAR(128),
                    username VARCHAR(64), created_at DATETIME);
CREATE TABLE events (id INTEGER PRIMARY KEY, title VARCHAR(64), currency VARCHAR(3),
                     invite_code VARCHAR(16) UNIQUE, owner_id BIGINT, created_at DATETIME);
CREATE TABLE members (event_id INTEGER, user_id BIGINT, joined_at DATETIME,
                      PRIMARY KEY (event_id, user_id));
CREATE TABLE expenses (id INTEGER PRIMARY KEY, event_id INTEGER, payer_id BIGINT,
                       amount BIGINT, description VARCHAR(100), created_by BIGINT,
                       created_at DATETIME);
INSERT INTO users VALUES (1001, 'Алиса', NULL, NULL, '2026-01-01 00:00:00');
INSERT INTO events VALUES (1, 'Старое', 'RUB', 'oldcode123', 1001, '2026-01-01 00:00:00');
INSERT INTO members VALUES (1, 1001, '2026-01-01 00:00:00');
INSERT INTO expenses VALUES (1, 1, 1001, 500, 'Старая трата', 1001, '2026-01-01 00:00:00');
"""


async def test_migration_adds_split_mode_column(tmp_path):
    """An old DB without expenses.split_mode is upgraded by init_db; old rows become 'equal'."""
    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.executescript(OLD_SCHEMA)
    con.commit()
    con.close()

    db.configure(path)
    try:
        await db.init_db()
        await db.init_db()  # idempotent
        async with db.session_scope() as session:
            old = await session.scalar(select(Expense).where(Expense.id == 1))
            assert old.split_mode == "equal"
            view = await s.add_expense(
                session, 1, A, 300, "Новая", A, split="exact", shares=[(A, 300)]
            )
            assert view.split == "exact"
    finally:
        await db.dispose()


# ---------------------------------------------------------------- API


async def _event_ab(client):
    ha = headers(ALICE)
    eid = (await client.post("/api/events", json={"title": "Т"}, headers=ha)).json()["id"]
    code = (await client.get(f"/api/events/{eid}", headers=ha)).json()["invite_code"]
    await client.post("/api/join", json={"invite_code": code}, headers=headers(BOB))
    return eid


async def test_exact_split_over_http(client):
    eid = await _event_ab(client)
    ha = headers(ALICE)
    r = await client.post(
        f"/api/events/{eid}/expenses",
        json={
            "amount": 150050,
            "description": "Отель",
            "payer_id": A,
            "split": "exact",
            "shares": [{"user_id": B, "amount": 100050}, {"user_id": A, "amount": 50000}],
        },
        headers=ha,
    )
    assert r.status_code == 200, r.text
    exp = r.json()
    assert exp["split"] == "exact"
    assert [(x["user"]["id"], x["amount"]) for x in exp["shares"]] == [(A, 50000), (B, 100050)]

    # Old clients (no `split`, no `shares`) behave exactly as before.
    r = await client.post(
        f"/api/events/{eid}/expenses",
        json={"amount": 100, "description": "Старый клиент", "payer_id": B, "participant_ids": [A, B]},
        headers=ha,
    )
    assert r.status_code == 200 and r.json()["split"] == "equal"

    listed = (await client.get(f"/api/events/{eid}/expenses", headers=ha)).json()
    assert [x["split"] for x in listed] == ["equal", "exact"]
    bal = (await client.get(f"/api/events/{eid}/balances", headers=ha)).json()
    assert {x["user"]["id"]: x["net"] for x in bal["balances"]} == {A: 100000, B: -100000}


async def test_exact_split_errors_over_http(client):
    eid = await _event_ab(client)
    ha = headers(ALICE)
    base = {"amount": 1000, "description": "x", "payer_id": A, "split": "exact"}
    cases = [
        ({"shares": [{"user_id": A, "amount": 400}, {"user_id": B, "amount": 500}]}, 400,
         "Сумма долей (9 ₽) не совпадает с суммой траты (10 ₽)"),
        ({"shares": [{"user_id": A, "amount": 1000}, {"user_id": B, "amount": 0}]}, 400,
         "Доля каждого участника должна быть больше нуля"),
        ({"shares": [{"user_id": A, "amount": 1500}, {"user_id": B, "amount": -500}]}, 400,
         "Доля каждого участника должна быть больше нуля"),
        ({"shares": [{"user_id": A, "amount": 500}, {"user_id": A, "amount": 500}]}, 400,
         "Участники не должны повторяться"),
        ({"shares": [{"user_id": A, "amount": 500}, {"user_id": M, "amount": 500}]}, 400,
         "Все участники траты должны быть участниками события"),
        ({"shares": [{"user_id": A, "amount": 1000}], "participant_ids": [A]}, 400,
         "При точном делении укажите доли, а не список участников"),
        ({"split": "equal", "participant_ids": [A], "shares": [{"user_id": A, "amount": 1000}]}, 400,
         "При равном делении доли не указываются"),
        ({"split": None, "participant_ids": [A], "shares": [{"user_id": A, "amount": 1000}]}, 400,
         "При равном делении доли не указываются"),
        ({"shares": []}, 400, "Укажите доли участников"),
        ({}, 400, "Укажите доли участников"),
        ({"split": "percent", "participant_ids": [A]}, 422,
         "Некорректный способ деления: допустимо «equal» или «exact»"),
        ({"shares": [{"user_id": A, "amount": 10.5}]}, 422, "Некорректный список долей"),
        ({"shares": [{"amount": 1000}]}, 422, "Некорректный список долей"),
    ]
    for extra, status, detail in cases:
        r = await client.post(f"/api/events/{eid}/expenses", json={**base, **extra}, headers=ha)
        assert (r.status_code, r.json()["detail"]) == (status, detail), extra

    r = await client.post(
        f"/api/events/{eid}/expenses",
        json={**base, "shares": [{"user_id": A, "amount": 1000}]},
        headers=headers(MALLORY),
    )
    assert r.status_code == 403
    assert (await client.get(f"/api/events/{eid}/expenses", headers=ha)).json() == []
