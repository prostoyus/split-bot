"""Application settings loaded from environment / .env file."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent

# Real environment variables take precedence over .env values.
load_dotenv(BASE_DIR / ".env", override=False)


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        raise ValueError(f"Environment variable {name} must be an integer, got {raw!r}") from None


def _resolve_path(raw: str) -> Path:
    path = Path(raw)
    return path if path.is_absolute() else BASE_DIR / path


@dataclass
class Settings:
    bot_token: str = ""
    webapp_url: str = ""
    public_api_url: str = ""
    api_port: int = 8080
    db_path: Path = BASE_DIR / "data" / "split.db"
    remind_every_days: int = 3
    allowed_origins: list[str] = field(default_factory=list)


def load_settings() -> Settings:
    origins = [
        o.strip().rstrip("/")
        for o in os.getenv("ALLOWED_ORIGINS", "").split(",")
        if o.strip()
    ]
    return Settings(
        bot_token=os.getenv("BOT_TOKEN", "").strip(),
        webapp_url=os.getenv("WEBAPP_URL", "").strip(),
        public_api_url=os.getenv("PUBLIC_API_URL", "").strip().rstrip("/"),
        api_port=_int_env("API_PORT", 8080),
        db_path=_resolve_path(os.getenv("DB_PATH", "").strip() or "data/split.db"),
        remind_every_days=max(1, _int_env("REMIND_EVERY_DAYS", 3)),
        allowed_origins=origins,
    )


settings = load_settings()
