"""Telegram Mini App initData validation and the FastAPI current-user dependency.

See https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from urllib.parse import parse_qsl

from fastapi import Depends, Header, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app import config, services
from app.db import get_session
from app.models import User

MAX_AGE_SECONDS = 24 * 60 * 60
MAX_FUTURE_SKEW_SECONDS = 5 * 60
MAX_INIT_DATA_LENGTH = 8192
MAX_TELEGRAM_ID = 2**53


class InitDataError(Exception):
    """initData is missing, malformed, forged or expired."""

    def __init__(self, message: str, expired: bool = False):
        super().__init__(message)
        self.expired = expired


@dataclass(frozen=True)
class TelegramUser:
    id: int
    first_name: str
    last_name: str | None
    username: str | None


def _secret_key(bot_token: str) -> bytes:
    return hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()


def compute_hash(fields: dict[str, str], bot_token: str) -> str:
    """HMAC-SHA256 hex of the data-check-string (all fields except `hash`, sorted)."""
    data_check_string = "\n".join(
        f"{k}={v}" for k, v in sorted(fields.items()) if k != "hash"
    )
    return hmac.new(_secret_key(bot_token), data_check_string.encode(), hashlib.sha256).hexdigest()


def validate_init_data(
    init_data: str,
    bot_token: str,
    max_age: int = MAX_AGE_SECONDS,
    now: float | None = None,
) -> TelegramUser:
    """Validate raw Telegram.WebApp.initData and return the user. Raises InitDataError."""
    if not bot_token:
        raise InitDataError("bot token is not configured")
    if not init_data or len(init_data) > MAX_INIT_DATA_LENGTH:
        raise InitDataError("init data is missing or too long")

    try:
        pairs = parse_qsl(init_data, keep_blank_values=True, strict_parsing=True)
    except ValueError:
        raise InitDataError("init data is malformed") from None
    fields: dict[str, str] = {}
    for key, value in pairs:
        if key in fields:
            raise InitDataError("duplicate field in init data")
        fields[key] = value

    received_hash = fields.get("hash")
    if not received_hash:
        raise InitDataError("hash is missing")
    expected_hash = compute_hash(fields, bot_token)
    # Compare as bytes: compare_digest rejects non-ASCII str with TypeError.
    if not hmac.compare_digest(expected_hash.encode(), received_hash.lower().encode()):
        raise InitDataError("hash mismatch")

    try:
        auth_date = int(fields.get("auth_date", ""))
    except ValueError:
        raise InitDataError("auth_date is invalid") from None
    current = time.time() if now is None else now
    if current - auth_date > max_age:
        raise InitDataError("init data expired", expired=True)
    if auth_date - current > MAX_FUTURE_SKEW_SECONDS:
        raise InitDataError("auth_date is in the future")

    try:
        user = json.loads(fields.get("user", ""))
        user_id = user["id"]
    except (ValueError, TypeError, KeyError):
        raise InitDataError("user field is invalid") from None
    if not isinstance(user_id, int) or isinstance(user_id, bool) or not 0 < user_id < MAX_TELEGRAM_ID:
        raise InitDataError("user id is invalid")

    def _opt_str(key: str) -> str | None:
        value = user.get(key)
        return value if isinstance(value, str) and value else None

    return TelegramUser(
        id=user_id,
        first_name=_opt_str("first_name") or "",
        last_name=_opt_str("last_name"),
        username=_opt_str("username"),
    )


async def get_current_user(
    x_telegram_init_data: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> User:
    """FastAPI dependency: validates X-Telegram-Init-Data and upserts the user."""
    if not x_telegram_init_data:
        raise HTTPException(401, "Нет данных авторизации. Откройте приложение через Telegram-бота.")
    try:
        tg_user = validate_init_data(x_telegram_init_data, config.settings.bot_token)
    except InitDataError as exc:
        if exc.expired:
            raise HTTPException(401, "Сессия устарела. Откройте приложение заново через бота.") from None
        raise HTTPException(401, "Не удалось проверить данные Telegram. Откройте приложение через бота.") from None
    return await services.upsert_user(
        session, tg_user.id, tg_user.first_name, tg_user.last_name, tg_user.username
    )
