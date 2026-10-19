"""Entry point: tunnel + FastAPI (uvicorn) + aiogram bot + reminders in one asyncio loop."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import socket
import sys

import uvicorn

from app import db, notifier
from app.api import create_app
from app.config import settings
from bot.keyboards import WebAppLinks
from bot.main import create_bot, create_dispatcher, install_token_redaction, setup_bot
from bot.reminders import run_reminders
from tunnel import CloudflaredTunnel, TunnelError

log = logging.getLogger("run")

API_HOST = "127.0.0.1"


class StartupError(RuntimeError):
    """Raised with a Russian, user-facing message."""


class _Server(uvicorn.Server):
    """uvicorn server that leaves Ctrl+C handling to asyncio.run (we stop it ourselves)."""

    @contextlib.contextmanager
    def capture_signals(self):
        yield


def _setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    # Quiet noisy libraries.
    for name in ("aiogram.event", "httpx", "uvicorn.access"):
        logging.getLogger(name).setLevel(logging.WARNING)
    install_token_redaction(settings.bot_token)


def _check_config() -> None:
    if not settings.bot_token:
        raise StartupError(
            "Не задан BOT_TOKEN. Создайте бота у @BotFather, скопируйте токен и впишите его "
            "в файл .env строкой BOT_TOKEN=... (пример — в файле .env.example)."
        )
    if not settings.webapp_url.startswith("https://"):
        raise StartupError(
            "Не задан WEBAPP_URL (адрес Mini App, должен начинаться с https://). "
            "Впишите его в файл .env, пример — в файле .env.example."
        )


def _check_port_free(port: int) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((API_HOST, port))
        except OSError:
            raise StartupError(
                f"Порт {port} уже занят (возможно, бот уже запущен в другом окне). "
                "Закройте другую копию или поменяйте API_PORT в .env."
            ) from None


async def _wait_started(server: uvicorn.Server, task: asyncio.Task, timeout: float = 15) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not server.started:
        if task.done():
            raise StartupError("Не удалось запустить API-сервер (подробности выше в логе).")
        if loop.time() > deadline:
            raise StartupError("API-сервер не запустился вовремя.")
        await asyncio.sleep(0.05)


async def main() -> int:
    _setup_logging()
    tunnel: CloudflaredTunnel | None = None
    bot = None
    tasks: list[asyncio.Task] = []
    server: _Server | None = None
    dp = None
    try:
        _check_config()
        _check_port_free(settings.api_port)
        await db.init_db()

        server = _Server(
            uvicorn.Config(
                create_app(), host=API_HOST, port=settings.api_port, log_level="warning"
            )
        )
        server_task = asyncio.create_task(server.serve(), name="api")
        tasks.append(server_task)
        await _wait_started(server, server_task)

        if settings.public_api_url:
            api_url = settings.public_api_url
        else:
            print("Запускаю туннель cloudflared, это может занять до минуты...")
            tunnel = CloudflaredTunnel(settings.api_port)
            api_url = await tunnel.start()

        links = WebAppLinks(webapp_url=settings.webapp_url, api_base=api_url)
        bot = create_bot(settings.bot_token)
        dp = create_dispatcher(links)
        try:
            sender = await setup_bot(bot, links)
        except Exception as exc:
            raise StartupError(
                "Не удалось связаться с Telegram. Проверьте BOT_TOKEN в .env и интернет. "
                f"Ошибка: {type(exc).__name__}"
            ) from exc

        tasks.append(
            asyncio.create_task(
                dp.start_polling(bot, handle_signals=False, close_bot_session=False),
                name="polling",
            )
        )
        tasks.append(
            asyncio.create_task(
                run_reminders(sender, settings.remind_every_days), name="reminders"
            )
        )
        print(f"Бот запущен. API: {api_url}. Нажмите Ctrl+C для остановки.")

        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            exc = task.exception()
            if exc is not None:
                log.error("Task %s failed: %r", task.get_name(), exc, exc_info=exc)
            else:
                log.error("Task %s stopped unexpectedly", task.get_name())
        return 1
    except StartupError as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        return 1
    except TunnelError as exc:
        print(f"Ошибка туннеля: {exc}", file=sys.stderr)
        return 1
    except asyncio.CancelledError:
        print("Останавливаю...")
        return 0
    finally:
        await _shutdown(server, dp, tasks, bot, tunnel)


async def _step(name: str, coro_fn) -> None:
    """Run one shutdown step; a failure is logged and never prevents the next steps."""
    try:
        await coro_fn()
    except (Exception, asyncio.CancelledError) as exc:  # noqa: BLE001
        log.warning("Shutdown step %r failed: %r", name, exc)


async def _shutdown(server, dp, tasks, bot, tunnel) -> None:
    notifier.set_notifier(None)
    if server is not None:
        server.should_exit = True

    async def stop_polling() -> None:
        if dp is None:
            return
        with contextlib.suppress(RuntimeError):  # "Polling is not started"
            await asyncio.wait_for(dp.stop_polling(), 10)

    async def stop_tasks() -> None:
        for task in tasks:
            if task.get_name() == "reminders":
                task.cancel()
        if not tasks:
            return
        _, pending = await asyncio.wait(tasks, timeout=10)
        for task in pending:
            task.cancel()
        await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 5)

    async def drain_notifications() -> None:
        drain = getattr(notifier, "drain", None)  # added to app.notifier separately
        if drain is not None:
            await drain(5)

    async def close_bot() -> None:
        if bot is not None:
            await bot.session.close()

    async def stop_tunnel() -> None:
        if tunnel is not None:
            await tunnel.stop()

    await _step("stop polling", stop_polling)
    await _step("stop tasks", stop_tasks)
    await _step("drain notifications", drain_notifications)
    await _step("close bot session", close_bot)
    await _step("stop tunnel", stop_tunnel)
    await _step("close database", db.dispose)
    log.info("Stopped")


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(0)
