import time

from app.notifier import drain
from tests.conftest import ALICE, BOB, CAROL, MALLORY, headers, make_init_data

A, B, C = ALICE["id"], BOB["id"], CAROL["id"]


async def test_health_without_auth(client):
    r = await client.get("/api/health")
    assert r.status_code == 200 and r.json() == {"ok": True}


async def test_auth_required(client):
    r = await client.get("/api/me")
    assert r.status_code == 401 and "Telegram" in r.json()["detail"]
    r = await client.get("/api/me", headers={"X-Telegram-Init-Data": "user=1&hash=abc&auth_date=1"})
    assert r.status_code == 401
    old = make_init_data(ALICE, auth_date=int(time.time()) - 90000)
    r = await client.get("/api/me", headers={"X-Telegram-Init-Data": old})
    assert r.status_code == 401 and "устарела" in r.json()["detail"]


async def test_me_and_config(client):
    r = await client.get("/api/me", headers=headers(ALICE))
    assert r.json() == {"id": A, "name": "Алиса Иванова", "username": "alice"}
    r = await client.get("/api/config", headers=headers(ALICE))
    assert r.json() == {"bot_username": "split_test_bot"}


async def test_cors(client):
    for origin, allowed in [
        ("https://prostoyus.github.io", True),
        ("http://localhost:5500", True),
        ("http://127.0.0.1:8000", True),
        ("https://evil.example.com", False),
    ]:
        r = await client.options(
            "/api/events",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "X-Telegram-Init-Data, Content-Type",
            },
        )
        assert (r.headers.get("access-control-allow-origin") == origin) is allowed, origin


async def test_internal_error_is_json_with_cors(database):
    import httpx

    from app.api import create_app

    app = create_app()

    @app.get("/api/boom")
    async def boom():
        raise RuntimeError("forced failure")

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.get("/api/boom", headers={"Origin": "https://prostoyus.github.io"})
    assert r.status_code == 500
    assert r.json() == {"detail": "Внутренняя ошибка сервера"}
    assert r.headers.get("access-control-allow-origin") == "https://prostoyus.github.io"


async def test_settlement_debt_rules_over_http(client):
    ha, hb = headers(ALICE), headers(BOB)
    eid = (await client.post("/api/events", json={"title": "Т"}, headers=ha)).json()["id"]
    code = (await client.get(f"/api/events/{eid}", headers=ha)).json()["invite_code"]
    await client.post("/api/join", json={"invite_code": code}, headers=hb)
    await client.post(
        f"/api/events/{eid}/expenses",
        json={"amount": 1000, "description": "x", "payer_id": A, "participant_ids": [A, B]},
        headers=ha,
    )
    r = await client.post(f"/api/events/{eid}/settlements", json={"to_id": A, "amount": 501}, headers=hb)
    assert r.status_code == 400 and r.json()["detail"] == "Сумма больше вашего долга этому участнику"
    r = await client.post(f"/api/events/{eid}/settlements", json={"to_id": A, "amount": 200}, headers=hb)
    assert r.status_code == 200
    r = await client.post(f"/api/events/{eid}/settlements", json={"to_id": A, "amount": 100}, headers=hb)
    assert r.status_code == 400 and r.json()["detail"] == "Предыдущий возврат ещё ждёт подтверждения"


async def test_validation_errors_in_russian(client):
    h = headers(ALICE)
    r = await client.post("/api/events", json={"title": 123}, headers=h)
    assert r.status_code == 422 and r.json()["detail"] == "Некорректное название события"
    r = await client.post("/api/events", json={"title": "x", "currency": "BTC"}, headers=h)
    assert r.status_code == 400 and "валюта" in r.json()["detail"]
    r = await client.get("/api/events/abc", headers=h)
    assert r.status_code == 422
    r = await client.get("/api/events/99999", headers=h)
    assert r.status_code == 404 and r.json()["detail"] == "Событие не найдено"
    r = await client.get("/api/nope", headers=h)
    assert r.status_code == 404 and r.json()["detail"] == "Не найдено"


async def test_end_to_end_flow(client, sent):
    ha, hb, hc, hm = headers(ALICE), headers(BOB), headers(CAROL), headers(MALLORY)

    # Alice creates an event.
    r = await client.post("/api/events", json={"title": "Поездка в Казань"}, headers=ha)
    assert r.status_code == 200, r.text
    event = r.json()
    eid, code = event["id"], event["invite_code"]
    assert event["currency"] == "RUB" and event["owner_id"] == A and event["my_net"] == 0
    assert event["invite_link"] == f"https://t.me/split_test_bot?start=join_{code}"
    assert [m["id"] for m in event["members"]] == [A]

    # Bob and Carol join (idempotent).
    for h in (hb, hc, hb):
        r = await client.post("/api/join", json={"invite_code": code}, headers=h)
        assert r.status_code == 200
    assert [m["id"] for m in r.json()["members"]] == [A, B, C]
    r = await client.post("/api/join", json={"invite_code": "wrongcode1"}, headers=hb)
    assert r.status_code == 404

    # Mallory is not a member.
    for path in ("", "/expenses", "/balances", "/settlements"):
        r = await client.get(f"/api/events/{eid}{path}", headers=hm)
        assert r.status_code == 403, path
    r = await client.post(
        f"/api/events/{eid}/expenses",
        json={"amount": 100, "description": "x", "payer_id": A, "participant_ids": [A]},
        headers=hm,
    )
    assert r.status_code == 403

    # Alice pays 1000.00 for all three -> 333.34 / 333.33 / 333.33.
    await drain(5)
    sent.clear()
    r = await client.post(
        f"/api/events/{eid}/expenses",
        json={"amount": 100000, "description": "Отель", "payer_id": A, "participant_ids": [C, B, A]},
        headers=ha,
    )
    assert r.status_code == 200, r.text
    exp = r.json()
    assert exp["payer"]["id"] == A and exp["created_by"] == A
    assert [(x["user"]["id"], x["amount"]) for x in exp["shares"]] == [(A, 33334), (B, 33333), (C, 33333)]
    await drain(5)
    assert sorted(uid for uid, _, _ in sent) == [B, C]

    # Bad expenses.
    bad = [
        {"amount": 10.5, "description": "x", "payer_id": A, "participant_ids": [A]},
        {"amount": "100", "description": "x", "payer_id": A, "participant_ids": [A]},
        {"amount": 100, "description": "x", "payer_id": A, "participant_ids": []},
        {"amount": 100, "description": "x", "payer_id": A, "participant_ids": [A, A]},
        {"amount": 100, "description": "x", "payer_id": MALLORY["id"], "participant_ids": [A]},
        {"amount": 100, "description": "x", "payer_id": A, "participant_ids": [MALLORY["id"]]},
        {"amount": 10**20, "description": "x", "payer_id": A, "participant_ids": [A]},
    ]
    for body in bad:
        r = await client.post(f"/api/events/{eid}/expenses", json=body, headers=ha)
        assert r.status_code in (400, 422), body
        assert isinstance(r.json()["detail"], str)

    # Balances.
    r = await client.get(f"/api/events/{eid}/balances", headers=hb)
    bal = r.json()
    nets = {x["user"]["id"]: x["net"] for x in bal["balances"]}
    assert nets == {A: 66666, B: -33333, C: -33333}
    assert sum(nets.values()) == 0
    assert [(t["from"]["id"], t["to"]["id"], t["amount"]) for t in bal["transfers"]] == [
        (B, A, 33333),
        (C, A, 33333),
    ]

    # Events list.
    r = await client.get("/api/events", headers=hb)
    assert r.json() == [
        {"id": eid, "title": "Поездка в Казань", "currency": "RUB", "members_count": 3, "my_net": -33333}
    ]

    # Bob pays back; only Alice may confirm.
    await drain(5)
    sent.clear()
    r = await client.post(f"/api/events/{eid}/settlements", json={"to_id": A, "amount": 33333}, headers=hb)
    assert r.status_code == 200, r.text
    st = r.json()
    assert st["status"] == "pending" and st["from"]["id"] == B and st["to"]["id"] == A
    await drain(5)
    assert [uid for uid, _, _ in sent] == [A]
    r = await client.post(f"/api/events/{eid}/settlements", json={"to_id": B, "amount": 1}, headers=hb)
    assert r.status_code == 400
    for h in (hb, hc, hm):
        r = await client.post(f"/api/settlements/{st['id']}/confirm", headers=h)
        assert r.status_code == 403
    r = await client.post(f"/api/settlements/{st['id']}/confirm", headers=ha)
    assert r.status_code == 200 and r.json()["status"] == "confirmed"
    r = await client.post(f"/api/settlements/{st['id']}/reject", headers=ha)
    assert r.status_code == 400
    r = await client.post("/api/settlements/424242/confirm", headers=ha)
    assert r.status_code == 404

    r = await client.get(f"/api/events/{eid}/balances", headers=ha)
    nets = {x["user"]["id"]: x["net"] for x in r.json()["balances"]}
    assert nets == {A: 33333, B: 0, C: -33333}
    r = await client.get(f"/api/events/{eid}/settlements", headers=hc)
    assert [x["id"] for x in r.json()] == [st["id"]]

    # Delete permissions: Carol (neither creator nor payer) cannot, Alice can.
    r = await client.delete(f"/api/expenses/{exp['id']}", headers=hc)
    assert r.status_code == 403
    r = await client.delete(f"/api/expenses/{exp['id']}", headers=hm)
    assert r.status_code == 403
    r = await client.delete(f"/api/expenses/{exp['id']}", headers=ha)
    assert r.status_code == 200 and r.json() == {"ok": True}
    r = await client.get(f"/api/events/{eid}/expenses", headers=hb)
    assert r.json() == []

    # The confirmed settlement remains: Bob is now owed back.
    r = await client.get(f"/api/events/{eid}", headers=hb)
    assert r.json()["my_net"] == 33333
