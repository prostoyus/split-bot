import hashlib
import hmac
import json
import os
import time
from urllib.parse import urlencode

import pytest

TEST_BOT_TOKEN = "123456:TEST-token-for-pytest"
# Must be set before `app` is imported so the real .env is never used for these values.
os.environ["BOT_TOKEN"] = TEST_BOT_TOKEN
os.environ["ALLOWED_ORIGINS"] = "https://prostoyus.github.io"

import httpx  # noqa: E402

from app import api, config, db, notifier  # noqa: E402

ALICE = {"id": 1001, "first_name": "Алиса", "last_name": "Иванова", "username": "alice"}
BOB = {"id": 1002, "first_name": "Боб", "username": "bob"}
CAROL = {"id": 1003, "first_name": "Кэрол"}
MALLORY = {"id": 6666, "first_name": "Mallory"}


def make_init_data(user: dict, auth_date: int | None = None, token: str = TEST_BOT_TOKEN) -> str:
    """Build initData signed exactly like Telegram does."""
    fields = {
        "auth_date": str(auth_date if auth_date is not None else int(time.time())),
        "query_id": "AAHdF6IQAAAAAN0XohDhrOrc",
        "user": json.dumps(user, ensure_ascii=False, separators=(",", ":")),
    }
    check = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


def headers(user: dict) -> dict:
    return {"X-Telegram-Init-Data": make_init_data(user)}


@pytest.fixture(autouse=True)
def _test_settings(monkeypatch):
    monkeypatch.setattr(config.settings, "bot_token", TEST_BOT_TOKEN)
    api.set_bot_username("split_test_bot")
    yield
    api.set_bot_username(None)


@pytest.fixture
async def database(tmp_path):
    db.configure(tmp_path / "test.db")
    await db.init_db()
    yield
    await db.dispose()


@pytest.fixture
async def session(database):
    async with db.session_scope() as s:
        yield s


@pytest.fixture
def sent():
    """Captures notifications as (user_id, text, extra)."""
    messages: list[tuple[int, str, dict | None]] = []

    async def fake_notify(user_id, text, extra=None):
        messages.append((user_id, text, extra))

    notifier.set_notifier(fake_notify)
    yield messages
    notifier.set_notifier(None)


@pytest.fixture
async def client(database):
    transport = httpx.ASGITransport(app=api.create_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
