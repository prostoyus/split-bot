"""FastAPI application: REST API for the Mini App (see SPEC.md)."""

from __future__ import annotations

import logging
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Path, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.exceptions import HTTPException as StarletteHTTPException

from app import config, services
from app.auth import get_current_user
from app.db import get_session, init_db
from app.models import User

log = logging.getLogger(__name__)

MAX_ID = 2**53
LOCAL_ORIGIN_REGEX = r"^http://(localhost|127\.0\.0\.1)(:\d+)?$"
RATE_LIMIT_REQUESTS = 120
RATE_LIMIT_WINDOW_SECONDS = 60

_bot_username: str | None = None


def set_bot_username(name: str | None) -> None:
    """Called by the bot at startup (from Bot.get_me())."""
    global _bot_username
    _bot_username = (name or "").lstrip("@") or None


def get_bot_username() -> str | None:
    return _bot_username


# ---------------------------------------------------------------- schemas

Id = Annotated[StrictInt, Field(ge=1, le=MAX_ID)]
IdPath = Annotated[int, Path(ge=1, le=MAX_ID)]


class _In(BaseModel):
    model_config = ConfigDict(extra="ignore")


class EventCreateIn(_In):
    title: StrictStr = Field(max_length=500)
    currency: StrictStr | None = Field(default="RUB", max_length=10)


class JoinIn(_In):
    invite_code: StrictStr = Field(max_length=64)


class ExpenseIn(_In):
    amount: StrictInt = Field(ge=-MAX_ID, le=MAX_ID)  # exact bounds checked in services
    description: StrictStr = Field(max_length=1000)
    payer_id: Id
    participant_ids: list[Id] = Field(max_length=services.MAX_PARTICIPANTS)


class SettlementIn(_In):
    to_id: Id
    amount: StrictInt = Field(ge=-MAX_ID, le=MAX_ID)


FIELD_ERRORS = {
    "title": "Некорректное название события",
    "currency": "Некорректная валюта",
    "invite_code": "Некорректный код приглашения",
    "amount": "Сумма должна быть целым числом в копейках",
    "description": "Некорректное описание",
    "payer_id": "Некорректный плательщик",
    "participant_ids": "Некорректный список участников",
    "to_id": "Некорректный получатель",
    "event_id": "Некорректный номер события",
    "expense_id": "Некорректный номер траты",
    "settlement_id": "Некорректный номер перевода",
}


# ---------------------------------------------------------------- serializers


def _dt(value: datetime | None) -> str | None:
    return value.isoformat(timespec="seconds") + "Z" if value else None


def user_out(user: User) -> dict:
    return {"id": user.id, "name": user.display_name, "username": user.username}


def invite_link(invite_code: str) -> str | None:
    if not _bot_username:
        return None
    return f"https://t.me/{_bot_username}?start=join_{invite_code}"


def event_detail_out(detail: services.EventDetail) -> dict:
    e = detail.event
    return {
        "id": e.id,
        "title": e.title,
        "currency": e.currency,
        "invite_code": e.invite_code,
        "invite_link": invite_link(e.invite_code),
        "owner_id": e.owner_id,
        "members": [user_out(u) for u in detail.members],
        "my_net": detail.my_net,
    }


def expense_out(x: services.ExpenseView) -> dict:
    return {
        "id": x.id,
        "payer": user_out(x.payer),
        "amount": x.amount,
        "description": x.description,
        "created_at": _dt(x.created_at),
        "created_by": x.created_by,
        "shares": [{"user": user_out(s.user), "amount": s.amount} for s in x.shares],
    }


def settlement_out(s: services.SettlementView) -> dict:
    return {
        "id": s.id,
        "from": user_out(s.from_user),
        "to": user_out(s.to_user),
        "amount": s.amount,
        "status": s.status,
        "created_at": _dt(s.created_at),
    }


# ---------------------------------------------------------------- rate limiting


class RateLimiter:
    """Simple in-memory sliding window per key (single-process app)."""

    def __init__(self, limit: int, window: float):
        self.limit = limit
        self.window = window
        self._hits: dict[int, deque[float]] = defaultdict(deque)

    def allow(self, key: int) -> bool:
        now = time.monotonic()
        hits = self._hits[key]
        while hits and now - hits[0] > self.window:
            hits.popleft()
        if len(hits) >= self.limit:
            return False
        hits.append(now)
        return True


async def current_user(request: Request, user: User = Depends(get_current_user)) -> User:
    if not request.app.state.rate_limiter.allow(user.id):
        raise HTTPException(429, "Слишком много запросов. Попробуйте через минуту.")
    return user


CurrentUser = Annotated[User, Depends(current_user)]
Session = Annotated[AsyncSession, Depends(get_session)]


# ---------------------------------------------------------------- errors


class InternalErrorMiddleware:
    """Turns unexpected exceptions into JSON 500 inside the CORS layer (so CORS headers are added)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def send_wrapper(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            log.exception("Unhandled error on %s %s", scope.get("method"), scope.get("path"))
            if started:
                raise
            response = JSONResponse({"detail": "Внутренняя ошибка сервера"}, status_code=500)
            await response(scope, receive, send)


# ---------------------------------------------------------------- app


def create_app() -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await init_db()
        yield

    app = FastAPI(
        title="Split Bot API",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.rate_limiter = RateLimiter(RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_SECONDS)

    # Order matters: the last added middleware is the outermost, so CORS wraps 500 responses too.
    app.add_middleware(InternalErrorMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.settings.allowed_origins,
        allow_origin_regex=LOCAL_ORIGIN_REGEX,
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["X-Telegram-Init-Data", "Content-Type"],
        max_age=600,
    )

    @app.exception_handler(services.ServiceError)
    async def _service_error(_req: Request, exc: services.ServiceError):
        return JSONResponse({"detail": exc.message}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_req: Request, exc: RequestValidationError):
        message = "Некорректные данные запроса"
        for err in exc.errors():
            names = [p for p in err.get("loc", ()) if isinstance(p, str) and p in FIELD_ERRORS]
            if names:
                message = FIELD_ERRORS[names[0]]
                break
        return JSONResponse({"detail": message}, status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_req: Request, exc: StarletteHTTPException):
        defaults = {404: "Не найдено", 405: "Метод не поддерживается"}
        detail = exc.detail
        if exc.status_code in defaults and detail in ("Not Found", "Method Not Allowed"):
            detail = defaults[exc.status_code]
        return JSONResponse({"detail": detail}, status_code=exc.status_code, headers=exc.headers)

    # ------------------------------------------------------------ routes

    @app.get("/api/health")
    async def health():
        return {"ok": True}

    @app.get("/api/config")
    async def get_config(_user: CurrentUser):
        return {"bot_username": _bot_username or ""}

    @app.get("/api/me")
    async def me(user: CurrentUser):
        return user_out(user)

    @app.get("/api/events")
    async def list_events(user: CurrentUser, session: Session):
        items = await services.list_user_events(session, user.id)
        return [
            {
                "id": e.id,
                "title": e.title,
                "currency": e.currency,
                "members_count": e.members_count,
                "my_net": e.my_net,
            }
            for e in items
        ]

    @app.post("/api/events")
    async def create_event(body: EventCreateIn, user: CurrentUser, session: Session):
        event = await services.create_event(session, user.id, body.title, body.currency)
        return event_detail_out(await services.get_event_detail(session, event.id, user.id))

    @app.get("/api/events/{event_id}")
    async def get_event(event_id: IdPath, user: CurrentUser, session: Session):
        return event_detail_out(await services.get_event_detail(session, event_id, user.id))

    @app.post("/api/join")
    async def join(body: JoinIn, user: CurrentUser, session: Session):
        event, _ = await services.join_by_invite_code(session, user.id, body.invite_code)
        return event_detail_out(await services.get_event_detail(session, event.id, user.id))

    @app.get("/api/events/{event_id}/expenses")
    async def list_expenses(event_id: IdPath, user: CurrentUser, session: Session):
        return [expense_out(x) for x in await services.list_expenses(session, event_id, user.id)]

    @app.post("/api/events/{event_id}/expenses")
    async def add_expense(event_id: IdPath, body: ExpenseIn, user: CurrentUser, session: Session):
        view = await services.add_expense(
            session,
            event_id,
            user.id,
            amount=body.amount,
            description=body.description,
            payer_id=body.payer_id,
            participant_ids=body.participant_ids,
        )
        return expense_out(view)

    @app.delete("/api/expenses/{expense_id}")
    async def delete_expense(expense_id: IdPath, user: CurrentUser, session: Session):
        await services.delete_expense(session, expense_id, user.id)
        return {"ok": True}

    @app.get("/api/events/{event_id}/balances")
    async def balances(event_id: IdPath, user: CurrentUser, session: Session):
        result = await services.get_event_balances(session, event_id, user.id)
        return {
            "balances": [{"user": user_out(b.user), "net": b.net} for b in result.balances],
            "transfers": [
                {"from": user_out(t.from_user), "to": user_out(t.to_user), "amount": t.amount}
                for t in result.transfers
            ],
        }

    @app.get("/api/events/{event_id}/settlements")
    async def list_settlements(event_id: IdPath, user: CurrentUser, session: Session):
        items = await services.list_settlements(session, event_id, user.id)
        return [settlement_out(s) for s in items]

    @app.post("/api/events/{event_id}/settlements")
    async def create_settlement(
        event_id: IdPath, body: SettlementIn, user: CurrentUser, session: Session
    ):
        view = await services.create_settlement(session, event_id, user.id, body.to_id, body.amount)
        return settlement_out(view)

    @app.post("/api/settlements/{settlement_id}/confirm")
    async def confirm(settlement_id: IdPath, user: CurrentUser, session: Session):
        return settlement_out(await services.confirm_settlement(session, settlement_id, user.id))

    @app.post("/api/settlements/{settlement_id}/reject")
    async def reject(settlement_id: IdPath, user: CurrentUser, session: Session):
        return settlement_out(await services.reject_settlement(session, settlement_id, user.id))

    return app
