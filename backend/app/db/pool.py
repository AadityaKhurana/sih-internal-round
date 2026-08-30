"""Async Postgres access layer for the API.

A single process-wide `AsyncConnectionPool` (psycopg 3). Connections yield rows
as dicts (`dict_row`). `json`/`jsonb` columns — including `ST_AsGeoJSON(...)::json`
— are parsed into Python objects automatically by psycopg.

The workers are separate processes and open their own connections from the same
`DATABASE_URL`; only the SQL schema and the event contract (`anpr_common`) are
shared, not this async pool.
"""
from __future__ import annotations

from typing import Any, Sequence

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from ..config import settings

_pool: AsyncConnectionPool | None = None


async def open_pool() -> AsyncConnectionPool:
    """Open the pool once at startup (called from the app lifespan)."""
    global _pool
    if _pool is None:
        _pool = AsyncConnectionPool(
            conninfo=settings.database_url,
            min_size=1,
            max_size=10,
            open=False,
            kwargs={"row_factory": dict_row},
        )
        await _pool.open(wait=True, timeout=10)
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def get_pool() -> AsyncConnectionPool:
    if _pool is None:
        raise RuntimeError("DB pool is not open; call open_pool() in the app lifespan")
    return _pool


async def fetch_all(sql: str, params: Sequence[Any] | None = None) -> list[dict[str, Any]]:
    async with get_pool().connection() as conn, conn.cursor() as cur:
        await cur.execute(sql, params)
        return await cur.fetchall()


async def fetch_one(sql: str, params: Sequence[Any] | None = None) -> dict[str, Any] | None:
    async with get_pool().connection() as conn, conn.cursor() as cur:
        await cur.execute(sql, params)
        return await cur.fetchone()
