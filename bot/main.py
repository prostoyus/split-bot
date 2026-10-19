"""Bot construction and startup wiring (menu button, commands, notifier)."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError, TelegramRetryAfter
from aiogram.types import BotCommand, MenuButtonWebApp, WebAppInfo

from app import api, notifier
from bot.handlers import create_router
from bot.keyboards import OPEN_APP_TEXT, WebAppLinks, open_event_keyboard

log = logging.getLogger(__name__)

# (user_id, html_text, extra) -> True if delivered, False if the user is unreachable.
Sender = Callable[[int, str, dict | None], Awaitable[bool]]

BOT_COMMANDS = [
    BotCommand(command="start", description="Открыть приложение"),
    BotCommand(command="debts", description="Мои долги"),
    BotCommand(command="help", description="Как пользоваться"),
]

MAX_RETRY_AFTER_SECONDS = 10


class TokenRedactingFilter(logging.Filter):
    """Replaces the bot token in any log record with '***' (defence in depth)."""

    def __init__(self, token: str) -> None:
        super().__init__()
        self._token = token

    def filter(self, record: logging.LogRecord) -> bool:
        if self._token:
            message = record.getMessage()
            if self._token in message:
                record.msg = message.replace(self._token, "***")
                record.args = None
        return True


def install_token_redaction(token: str) -> None:
    redactor = TokenRedactingFilter(token)
    for handler in logging.getLogger().handlers:
        handler.addFilter(redactor)


def create_bot(token: str) -> Bot:
    return Bot(token=token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))


def create_dispatcher(links: WebAppLinks) -> Dispatcher:
    dp = Dispatcher()
    dp["links"] = links  # injected into handlers as the `links` argument
    dp.include_router(create_router())
    return dp


def make_sender(bot: Bot, links: WebAppLinks) -> Sender:
    """Build a function that sends an HTML message with a web_app button to the event."""

    async def send(user_id: int, text: str, extra: dict | None = None) -> bool:
        event_id = (extra or {}).get("event_id")
        markup = open_event_keyboard(links, event_id)
        for attempt in range(2):
            try:
                await bot.send_message(user_id, text, reply_markup=markup)
                return True
            except TelegramForbiddenError:
                # User blocked the bot or never pressed Start: nothing we can do.
                log.info("User %s is unreachable (blocked the bot or never started it)", user_id)
                return False
            except TelegramBadRequest as exc:
                if "chat not found" in str(exc).lower():
                    log.info("User %s is unreachable (chat not found)", user_id)
                    return False
                raise
            except TelegramRetryAfter as exc:
                if attempt == 0 and exc.retry_after <= MAX_RETRY_AFTER_SECONDS:
                    await asyncio.sleep(exc.retry_after)
                    continue
                raise
        return False

    return send


async def setup_bot(bot: Bot, links: WebAppLinks) -> Sender:
    """Configure the bot for the given public API URL. Returns the message sender."""
    me = await bot.get_me()
    api.set_bot_username(me.username)
    await bot.set_chat_menu_button(
        menu_button=MenuButtonWebApp(text=OPEN_APP_TEXT, web_app=WebAppInfo(url=links.url()))
    )
    await bot.set_my_commands(BOT_COMMANDS)

    sender = make_sender(bot, links)

    async def notify(user_id: int, text: str, extra: dict | None = None) -> None:
        await sender(user_id, text, extra)

    notifier.set_notifier(notify)
    log.info("Bot @%s is set up", me.username)
    return sender
