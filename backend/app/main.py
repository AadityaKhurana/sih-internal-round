import asyncio
from contextlib import asynccontextmanager

import psycopg
import redis.asyncio as aioredis
from fastapi import FastAPI

from .config import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.redis = aioredis.from_url(
        settings.redis_url, socket_connect_timeout=2, socket_timeout=2
    )
    try:
        yield
    finally:
        await app.state.redis.aclose()


app = FastAPI(title="City-Wide ANPR API", version="0.1.0", lifespan=lifespan)


def _check_postgres() -> dict:
    """Blocking DB probe; run in a thread from the async handler."""
    try:
        with psycopg.connect(settings.database_url, connect_timeout=3) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
                cur.execute("SELECT 1 FROM pg_extension WHERE extname = 'postgis'")
                has_postgis = cur.fetchone() is not None
        return {"postgres": "ok", "postgis": has_postgis}
    except Exception as exc:  # noqa: BLE001 - surface class name only
        return {"postgres": f"error: {exc.__class__.__name__}", "postgis": False}


@app.get("/")
async def root():
    return {"service": "city-wide-anpr", "version": "0.1.0", "env": settings.app_env}


@app.get("/health")
async def health():
    checks = await asyncio.to_thread(_check_postgres)

    try:
        await app.state.redis.ping()
        checks["redis"] = "ok"
    except Exception as exc:  # noqa: BLE001
        checks["redis"] = f"error: {exc.__class__.__name__}"

    healthy = checks.get("postgres") == "ok" and checks.get("redis") == "ok"
    return {
        "status": "ok" if healthy else "degraded",
        "env": settings.app_env,
        "checks": checks,
    }
