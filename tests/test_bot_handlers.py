"""Handlers tested end-to-end through the Dispatcher with a fake Telegram session (no network)."""

from datetime import datetime

from aiogram import Bot
from aiogram.client.session.base import BaseSession
from aiogram.methods import SendMessage
from aiogram.types import Chat, Message, Update, User

from app import services as s
from bot.keyboards import WebAppLinks
from bot.main import create_dispatcher
from tests.conftest import ALICE, BOB

LINKS = WebAppLinks("https://x.io/app/", "https://a-b.trycloudflare.com")


class FakeSession(BaseSession):
    def __init__(self):
        super().__init__()
        self.requests = []

    async def make_request(self, bot, method, timeout=None):
        self.requests.append(method)
        if isinstance(method, SendMessage):
            return Message(
                message_id=len(self.requests),
                date=datetime.now(),
                chat=Chat(id=method.chat_id, type="private"),
                text=method.text,
            )
        return True

    async def stream_content(self, *args, **kwargs):  # pragma: no cover
        raise NotImplementedError

    async def close(self):
        pass


def _update(user: dict, text: str, update_id: int = 1) -> Update:
    tg_user = User(id=user["id"], is_bot=False, first_name=user["first_name"],
                   last_name=user.get("last_name"), username=user.get("username"))
    return Update(
        update_id=update_id,
        message=Message(
            message_id=update_id,
            date=datetime.now(),
            chat=Chat(id=user["id"], type="private"),
            from_user=tg_user,
            text=text,
        ),
    )


async def _send(text: str, user: dict = BOB) -> list[SendMessage]:
    session = FakeSession()
    bot = Bot("123456:TEST-token-for-pytest", session=session)
    dp = create_dispatcher(LINKS)
    await dp.feed_update(bot, _update(user, text))
    return [m for m in session.requests if isinstance(m, SendMessage)]


async def test_start_greets_with_open_button(database):
    [reply] = await _send("/start")
    assert "Кто кому должен" in reply.text
    assert reply.reply_markup.inline_keyboard[0][0].web_app.url.startswith("https://x.io/app/?api=")


async def test_start_join_and_rejoin(session):
    await s.upsert_user(session, ALICE["id"], ALICE["first_name"])
    event = await s.create_event(session, ALICE["id"], "Дача <2026>", "RUB")

    [reply] = await _send(f"/start join_{event.invite_code}")
    assert reply.text == "Вы в событии «Дача &lt;2026&gt;»"
    assert reply.reply_markup.inline_keyboard[0][0].web_app.url.endswith(f"&event={event.id}")

    [reply] = await _send(f"/start join_{event.invite_code}")
    assert reply.text == "Вы уже в событии «Дача &lt;2026&gt;»"


async def test_start_join_invalid_code(database):
    [reply] = await _send("/start join_doesnotexist")
    assert "приглашение не найдено" in reply.text


async def test_debts_empty(database):
    [reply] = await _send("/debts")
    assert reply.text == "Долгов нет 🎉"


async def test_help_and_fallback(database):
    [reply] = await _send("/help")
    assert "/debts" in reply.text
    [reply] = await _send("просто текст")
    assert "/start" in reply.text
