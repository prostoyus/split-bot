"""Bot command handlers: /start, /start join_<code>, /help, /debts."""

from __future__ import annotations

import html
import logging
from collections.abc import Sequence

from aiogram import F, Router
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import ErrorEvent, Message
from aiogram.types import User as TgUser

from app import services
from app.db import session_scope
from app.money import format_money
from bot.keyboards import WebAppLinks, open_app_keyboard, open_event_keyboard

log = logging.getLogger(__name__)

MAX_MESSAGE_LEN = 4096
JOIN_PREFIX = "join_"

GREETING_TEXT = (
    "Привет! Я бот <b>«Кто кому должен»</b>.\n\n"
    "Помогаю делить общие траты — в поездке, на вечеринке, в съёмной квартире:\n"
    "• создайте событие и пригласите друзей по ссылке;\n"
    "• записывайте, кто за что заплатил;\n"
    "• я посчитаю, кто кому сколько должен, с минимумом переводов;\n"
    "• отмечайте возвраты, а я напомню должникам.\n\n"
    "Нажмите «Открыть», чтобы начать."
)

HELP_TEXT = (
    "<b>Как пользоваться</b>\n\n"
    "1. Нажмите «Открыть» (или кнопку меню слева от поля ввода).\n"
    "2. Создайте событие, например «Поездка в Казань».\n"
    "3. На вкладке «Участники» нажмите «Пригласить» и отправьте ссылку друзьям.\n"
    "4. Добавляйте траты: сумму, описание, кто платил и на кого делить.\n"
    "5. На вкладке «Балансы» видно, кто кому должен. Вернули деньги — нажмите «Я вернул», "
    "получатель подтвердит.\n\n"
    "<b>Команды</b>\n"
    "/start — открыть приложение\n"
    "/debts — мои долги по всем событиям\n"
    "/help — эта справка"
)

NO_DEBTS_TEXT = "Долгов нет 🎉"
INVITE_NOT_FOUND_TEXT = (
    "Не получилось присоединиться: приглашение не найдено. "
    "Попросите у друзей свежую ссылку."
)
ERROR_TEXT = "Что-то пошло не так. Попробуйте ещё раз чуть позже."
UNKNOWN_TEXT = "Я понимаю команды /start, /debts и /help. Всё остальное — в приложении:"

# ---------------------------------------------------------------- pure helpers


def split_message(text: str, limit: int = MAX_MESSAGE_LEN) -> list[str]:
    """Split text into chunks <= limit, preferring line boundaries."""
    if len(text) <= limit:
        return [text]
    chunks: list[str] = []
    current = ""
    for line in text.split("\n"):
        while len(line) > limit:  # a single very long line: hard cut
            if current:
                chunks.append(current)
                current = ""
            chunks.append(line[:limit])
            line = line[limit:]
        candidate = f"{current}\n{line}" if current else line
        if len(candidate) > limit:
            chunks.append(current)
            current = line
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks


def format_debts_summary(items: Sequence[services.UserEventDebts]) -> str:
    """Human readable (HTML) summary of the user's debts across events."""
    if not items:
        return NO_DEBTS_TEXT
    blocks: list[str] = ["<b>Ваши долги</b>"]
    for item in items:
        lines = [f"<b>«{html.escape(item.title)}»</b>"]
        for t in item.owes:
            name = html.escape(t.to_user.display_name)
            lines.append(f"Вы должны: {name} — {format_money(t.amount, item.currency)}")
        for t in item.owed_by:
            name = html.escape(t.from_user.display_name)
            lines.append(f"Вам должен(-а): {name} — {format_money(t.amount, item.currency)}")
        if not item.owes and not item.owed_by:
            lines.append(f"Ваш баланс: {format_money(item.net, item.currency)}")
        blocks.append("\n".join(lines))
    blocks.append("Подробности и кнопка «Я вернул» — в приложении.")
    return "\n\n".join(blocks)


def parse_join_code(args: str | None) -> str | None:
    """Return the invite payload if /start args look like `join_<code>`, else None."""
    if not args:
        return None
    args = args.strip()
    return args if args.startswith(JOIN_PREFIX) else None


async def _upsert(tg_user: TgUser | None) -> int | None:
    if tg_user is None:
        return None
    async with session_scope() as session:
        await services.upsert_user(
            session,
            tg_user.id,
            tg_user.first_name or "",
            tg_user.last_name,
            tg_user.username,
        )
    return tg_user.id


# ---------------------------------------------------------------- handlers


async def cmd_start(message: Message, command: CommandObject, links: WebAppLinks) -> None:
    user_id = await _upsert(message.from_user)
    code = parse_join_code(command.args)
    if code is None or user_id is None:
        await message.answer(GREETING_TEXT, reply_markup=open_app_keyboard(links))
        return

    try:
        async with session_scope() as session:
            event, joined_now = await services.join_by_invite_code(session, user_id, code)
    except services.ServiceError as exc:
        log.info("Join failed for user %s: %s", user_id, exc.message)
        await message.answer(INVITE_NOT_FOUND_TEXT, reply_markup=open_app_keyboard(links))
        return

    title = html.escape(event.title)
    text = f"Вы в событии «{title}»" if joined_now else f"Вы уже в событии «{title}»"
    await message.answer(text, reply_markup=open_event_keyboard(links, event.id))


async def cmd_help(message: Message, links: WebAppLinks) -> None:
    await _upsert(message.from_user)
    await message.answer(HELP_TEXT, reply_markup=open_app_keyboard(links))


async def cmd_debts(message: Message, links: WebAppLinks) -> None:
    user_id = await _upsert(message.from_user)
    if user_id is None:
        return
    async with session_scope() as session:
        items = await services.get_user_debts_summary(session, user_id)
    chunks = split_message(format_debts_summary(items))
    for i, chunk in enumerate(chunks):
        markup = open_app_keyboard(links) if i == len(chunks) - 1 else None
        await message.answer(chunk, reply_markup=markup)


async def fallback(message: Message, links: WebAppLinks) -> None:
    await _upsert(message.from_user)
    await message.answer(UNKNOWN_TEXT, reply_markup=open_app_keyboard(links))


async def on_error(event: ErrorEvent) -> bool:
    log.error("Unhandled error in handler: %r", event.exception, exc_info=event.exception)
    message = event.update.message
    if message is not None:
        try:
            await message.answer(ERROR_TEXT)
        except Exception:  # noqa: BLE001 - best effort only
            log.warning("Could not send error message to chat %s", message.chat.id)
    return True


def create_router() -> Router:
    """A fresh router with all handlers (a router can be attached to only one dispatcher)."""
    router = Router(name="main")
    # Mini App (web_app) buttons work only in private chats.
    router.message.filter(F.chat.type == "private")
    router.message.register(cmd_start, CommandStart())
    router.message.register(cmd_help, Command("help"))
    router.message.register(cmd_debts, Command("debts"))
    router.message.register(fallback)
    router.errors.register(on_error)
    return router
