import asyncio
from datetime import UTC, datetime, timedelta

from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError
from aiogram.methods import SendMessage

from app import services as s
from bot import reminders
from bot.keyboards import WebAppLinks
from bot.main import make_sender
from tests.conftest import ALICE, BOB


async def _debt(session):
    for u in (ALICE, BOB):
        await s.upsert_user(session, u["id"], u["first_name"], u.get("last_name"), u.get("username"))
    event = await s.create_event(session, ALICE["id"], "Поездка", "RUB")
    await s.join_by_invite_code(session, BOB["id"], event.invite_code)
    await s.add_expense(
        session, event.id, ALICE["id"], 100000, "Ужин", ALICE["id"], [ALICE["id"], BOB["id"]]
    )
    return event


async def test_sends_once_then_throttles(session, monkeypatch):
    monkeypatch.setattr(reminders, "PAUSE_BETWEEN_MESSAGES_SECONDS", 0)
    event = await _debt(session)
    calls = []

    async def sender(uid, text, extra):
        calls.append((uid, text, extra))
        return True

    now = datetime.now(UTC)
    assert await reminders.send_due_reminders(sender, 3, now) == 1
    assert calls == [
        (BOB["id"], "Напоминание: вы должны 500 ₽ в «Поездка»", {"event_id": event.id})
    ]
    assert await reminders.send_due_reminders(sender, 3, now + timedelta(days=1)) == 0
    assert await reminders.send_due_reminders(sender, 3, now + timedelta(days=4)) == 1


async def test_failed_send_is_not_marked_and_loop_survives(session, monkeypatch):
    monkeypatch.setattr(reminders, "PAUSE_BETWEEN_MESSAGES_SECONDS", 0)
    await _debt(session)
    attempts = 0

    async def broken(uid, text, extra):
        nonlocal attempts
        attempts += 1
        raise RuntimeError("network down")

    task = asyncio.create_task(reminders.run_reminders(broken, 3, interval_seconds=0.01))
    await asyncio.sleep(0.3)
    assert not task.done()
    task.cancel()
    assert attempts >= 2  # not marked as reminded -> retried on the next tick


class FakeBot:
    def __init__(self, exc=None):
        self.exc = exc
        self.sent = []

    async def send_message(self, chat_id, text, reply_markup=None):
        if self.exc:
            raise self.exc
        self.sent.append((chat_id, text, reply_markup))


LINKS = WebAppLinks("https://x.io/app/", "https://a.trycloudflare.com")


async def test_sender_adds_event_button():
    bot = FakeBot()
    assert await make_sender(bot, LINKS)(1, "hi", {"event_id": 3}) is True
    _, _, markup = bot.sent[0]
    assert markup.inline_keyboard[0][0].web_app.url.endswith("&event=3")


async def test_sender_swallows_forbidden_and_chat_not_found():
    method = SendMessage(chat_id=1, text="hi")
    forbidden = TelegramForbiddenError(method=method, message="Forbidden: bot was blocked by the user")
    not_found = TelegramBadRequest(method=method, message="Bad Request: chat not found")
    assert await make_sender(FakeBot(forbidden), LINKS)(1, "hi", None) is False
    assert await make_sender(FakeBot(not_found), LINKS)(1, "hi", None) is False
