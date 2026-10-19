"""Background task that reminds debtors about their debts."""

from __future__ import annotations

import asyncio
import html
import logging
from datetime import UTC, datetime

from app import services
from app.db import session_scope
from app.money import format_money
from bot.main import Sender

log = logging.getLogger(__name__)

DEFAULT_INTERVAL_SECONDS = 60 * 60
PAUSE_BETWEEN_MESSAGES_SECONDS = 0.1  # stay well below Telegram rate limits


def reminder_text(reminder: services.DebtReminder) -> str:
    amount = format_money(reminder.amount, reminder.currency)
    return f"Напоминание: вы должны {amount} в «{html.escape(reminder.event_title)}»"


async def send_due_reminders(
    sender: Sender, remind_every_days: int, now: datetime | None = None
) -> int:
    """Send all due reminders once. Returns how many were processed successfully."""
    now = now or datetime.now(UTC)
    async with session_scope() as session:
        due = await services.find_debtors_to_remind(session, now, remind_every_days)
    done = 0
    for reminder in due:
        try:
            await sender(reminder.user_id, reminder_text(reminder), {"event_id": reminder.event_id})
            # Mark even if the user is unreachable, so we retry only after the throttle period.
            async with session_scope() as session:
                await services.mark_reminded(session, reminder.event_id, reminder.user_id, now)
            done += 1
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception(
                "Failed to remind user %s about event %s", reminder.user_id, reminder.event_id
            )
        await asyncio.sleep(PAUSE_BETWEEN_MESSAGES_SECONDS)
    if due:
        log.info("Reminders: %s of %s sent", done, len(due))
    return done


async def run_reminders(
    sender: Sender,
    remind_every_days: int,
    interval_seconds: float = DEFAULT_INTERVAL_SECONDS,
) -> None:
    """Run forever: check for due reminders every `interval_seconds`. Never crashes on errors."""
    while True:
        try:
            await send_due_reminders(sender, remind_every_days)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Reminder check failed; will retry later")
        await asyncio.sleep(interval_seconds)
