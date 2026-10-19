"""Cloudflare quick tunnel launcher (tools/cloudflared.exe)."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from pathlib import Path

log = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_CLOUDFLARED = BASE_DIR / "tools" / "cloudflared.exe"

TUNNEL_URL_RE = re.compile(r"https://([a-z0-9-]+)\.trycloudflare\.com")
# Hosts that appear in cloudflared logs but are not a tunnel address.
_SERVICE_SUBDOMAINS = {"api", "www"}
_CONNECTED_MARKER = "Registered tunnel connection"

URL_TIMEOUT_SECONDS = 60.0
CONNECT_TIMEOUT_SECONDS = 20.0


class TunnelError(RuntimeError):
    """Raised with a Russian, user-facing message."""


def parse_tunnel_url(line: str) -> str | None:
    """Return the first `https://<name>.trycloudflare.com` tunnel URL in a log line, if any."""
    for match in TUNNEL_URL_RE.finditer(line):
        if match.group(1) not in _SERVICE_SUBDOMAINS:
            return match.group(0)
    return None


class CloudflaredTunnel:
    def __init__(self, port: int, executable: Path | str = DEFAULT_CLOUDFLARED) -> None:
        self.port = port
        self.executable = Path(executable)
        self.url: str | None = None
        self._process: asyncio.subprocess.Process | None = None
        self._reader: asyncio.Task | None = None
        self._url_future: asyncio.Future[str] | None = None
        self._connected = asyncio.Event()

    async def start(self, timeout: float = URL_TIMEOUT_SECONDS) -> str:
        """Start cloudflared and return the public https URL."""
        if not self.executable.is_file():
            raise TunnelError(
                f"Не найден файл {self.executable}. Скачайте cloudflared.exe в папку tools "
                "или укажите PUBLIC_API_URL в файле .env."
            )
        loop = asyncio.get_running_loop()
        self._url_future = loop.create_future()
        try:
            self._process = await asyncio.create_subprocess_exec(
                str(self.executable),
                "tunnel",
                "--url",
                f"http://127.0.0.1:{self.port}",
                "--no-autoupdate",
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as exc:
            raise TunnelError(f"Не удалось запустить cloudflared: {exc}") from exc
        self._reader = asyncio.create_task(self._drain(), name="cloudflared-output")

        try:
            self.url = await asyncio.wait_for(asyncio.shield(self._url_future), timeout)
        except TimeoutError:
            await self.stop()
            raise TunnelError(
                f"cloudflared не выдал адрес туннеля за {int(timeout)} сек. "
                "Проверьте подключение к интернету и попробуйте ещё раз."
            ) from None
        except TunnelError:
            await self.stop()
            raise

        # The URL is printed before the tunnel is really connected; wait a bit (not fatal).
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._connected.wait(), CONNECT_TIMEOUT_SECONDS)
        log.info("Tunnel is up: %s", self.url)
        return self.url

    async def _drain(self) -> None:
        """Read cloudflared output until it exits (otherwise its pipe buffer would fill up)."""
        assert self._process is not None and self._process.stderr is not None
        stream = self._process.stderr
        try:
            while True:
                raw = await stream.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").rstrip()
                log.debug("cloudflared: %s", line)
                if self._url_future is not None and not self._url_future.done():
                    url = parse_tunnel_url(line)
                    if url:
                        self._url_future.set_result(url)
                if _CONNECTED_MARKER in line:
                    self._connected.set()
        finally:
            code = await self._process.wait()
            if self._url_future is not None and not self._url_future.done():
                self._url_future.set_exception(
                    TunnelError(f"cloudflared завершился (код {code}), не создав туннель.")
                )
            elif self.url:
                log.warning("cloudflared exited with code %s", code)

    async def stop(self) -> None:
        process = self._process
        if process is not None and process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 10)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
                await process.wait()
        if self._reader is not None:
            self._reader.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._reader
        self._reader = None
        self._process = None
        if self._url_future is not None and not self._url_future.done():
            self._url_future.cancel()


async def _demo() -> None:  # pragma: no cover - manual smoke test
    logging.basicConfig(level=logging.INFO)
    tunnel = CloudflaredTunnel(8080)
    try:
        print("URL:", await tunnel.start())
    finally:
        await tunnel.stop()
        print("stopped")


if __name__ == "__main__":  # pragma: no cover
    asyncio.run(_demo())
