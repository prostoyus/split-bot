"""Async SQLite engine and session factory."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings
from app.models import Base

log = logging.getLogger(__name__)

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def _set_sqlite_pragmas(dbapi_connection, _record) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()


def configure(db_path: str | Path | None = None) -> None:
    """(Re)create the engine for the given SQLite file (defaults to settings.db_path)."""
    global _engine, _sessionmaker
    path = Path(db_path) if db_path else settings.db_path
    path.parent.mkdir(parents=True, exist_ok=True)
    _engine = create_async_engine(f"sqlite+aiosqlite:///{path.as_posix()}")
    event.listen(_engine.sync_engine, "connect", _set_sqlite_pragmas)
    _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)


def get_engine() -> AsyncEngine:
    if _engine is None:
        configure()
    assert _engine is not None
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    if _sessionmaker is None:
        configure()
    assert _sessionmaker is not None
    return _sessionmaker


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """Usage: `async with session_scope() as session: ...` (services commit themselves)."""
    async with get_sessionmaker()() as session:
        yield session


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: one session per request."""
    async with get_sessionmaker()() as session:
        yield session


async def init_db() -> None:
    """Create all tables if they do not exist (idempotent)."""
    async with get_engine().begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_add_missing_columns)
        # create_all skips indexes of tables that already exist; add any missing ones.
        await conn.run_sync(_create_missing_indexes)


# Columns added after the first release: (table, column, DDL). Applied to existing DBs by init_db().
# Table/column names are constants from this list, never user input.
_ADDED_COLUMNS = [
    (
        "expenses",
        "split_mode",
        "VARCHAR(8) NOT NULL DEFAULT 'equal' CHECK (split_mode IN ('equal', 'exact'))",
    ),
]


def _add_missing_columns(sync_conn) -> None:
    for table, column, ddl in _ADDED_COLUMNS:
        existing = {row[1] for row in sync_conn.exec_driver_sql(f"PRAGMA table_info({table})")}
        if column not in existing:
            log.info("Migrating DB: adding %s.%s", table, column)
            sync_conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def _create_missing_indexes(sync_conn) -> None:
    for table in Base.metadata.sorted_tables:
        for index in table.indexes:
            try:
                index.create(sync_conn, checkfirst=True)
            except Exception:
                log.exception("Could not create index %s", index.name)


async def dispose() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None
