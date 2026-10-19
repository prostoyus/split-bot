"""Notification hook. The bot injects a sender via set_notifier(); backend never imports aiogram.

notify() never blocks the caller: delivery runs as a background task. Use drain() to wait
for pending deliveries (graceful shutdown, tests).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

log = logging.getLogger(__name__)

# (user_id, html_text, extra) ; extra may hold {"event_id": int}
Notify = Callable[[int, str, dict | None], Awaitable[None]]

NOTIFY_TIMEOUT_SECONDS = 15

_notifier: Notify | None = None
# Strong references so tasks are not garbage-collected before they finish.
_pending: set[asyncio.Task] = set()


def set_notifier(fn: Notify | None) -> None:
    global _notifier
    _notifier = fn


async def _deliver(fn: Notify, user_id: int, text: str, extra: dict | None) -> None:
    try:
        await asyncio.wait_for(fn(user_id, text, extra), timeout=NOTIFY_TIMEOUT_SECONDS)
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("Failed to notify user %s", user_id)


async def notify(user_id: int, text: str, extra: dict | None = None) -> None:
    """Schedule a notification in the background; no-op if no notifier is set. Never raises."""
    fn = _notifier
    if fn is None:
        return
    task = asyncio.create_task(_deliver(fn, user_id, text, extra))
    _pending.add(task)
    task.add_done_callback(_pending.discard)


def pending_count() -> int:
    return len(_pending)


async def drain(timeout: float | None = None) -> None:
    """Wait for pending deliveries (including ones scheduled meanwhile); cancel leftovers on timeout."""
    loop = asyncio.get_running_loop()
    deadline = None if timeout is None else loop.time() + timeout
    while _pending:
        remaining = None if deadline is None else deadline - loop.time()
        if remaining is not None and remaining <= 0:
            break
        _done, not_done = await asyncio.wait(set(_pending), timeout=remaining)
        if not_done and remaining is not None and deadline - loop.time() <= 0:
            break
    leftovers = list(_pending)
    for task in leftovers:
        task.cancel()
    if leftovers:
        log.warning("Cancelled %d undelivered notification(s)", len(leftovers))
        await asyncio.gather(*leftovers, return_exceptions=True)
