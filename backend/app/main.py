import asyncio
import contextlib
import json
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import redis.asyncio as aioredis
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .api import api_router
from .api._common import iso
from .config import settings
from .db import close_pool, get_pool, open_pool
from .realtime import alerts_subscriber, manager, sightings_subscriber

logger = logging.getLogger("anpr.api")


def _now() -> str:
    return iso(datetime.now(timezone.utc))


@asynccontextmanager
async def lifespan(app: FastAPI):
    await open_pool()
    if not settings.api_auth_token:
        logger.warning("API_AUTH_TOKEN is not set — bearer auth DISABLED (dev mode).")
    app.state.redis = aioredis.from_url(
        settings.redis_url, socket_connect_timeout=2, socket_timeout=2
    )
    stop = asyncio.Event()
    subs = [
        asyncio.create_task(alerts_subscriber(settings.redis_url, stop)),
        asyncio.create_task(sightings_subscriber(settings.redis_url, stop)),
    ]
    try:
        yield
    finally:
        stop.set()
        for t in subs:
            t.cancel()
        for t in subs:
            with contextlib.suppress(asyncio.CancelledError):
                await t
        await app.state.redis.aclose()
        await close_pool()


app = FastAPI(title="City-Wide ANPR API", version="0.1.0", lifespan=lifespan)

# Dev CORS. TODO(auth): tighten allow_origins before any real deploy.
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

# All data endpoints live under /api to match the frontend contract + dev proxy.
app.include_router(api_router, prefix="/api")


@app.get("/")
async def root():
    return {"service": "city-wide-anpr", "version": "0.1.0", "env": settings.app_env}


@app.get("/health")
async def health():
    checks: dict = {}
    try:
        async with get_pool().connection() as conn, conn.cursor() as cur:
            await cur.execute("SELECT 1 FROM pg_extension WHERE extname = 'postgis'")
            checks["postgres"] = "ok"
            checks["postgis"] = (await cur.fetchone()) is not None
    except Exception as exc:  # noqa: BLE001
        checks["postgres"] = f"error: {exc.__class__.__name__}"
        checks["postgis"] = False
    try:
        await app.state.redis.ping()
        checks["redis"] = "ok"
    except Exception as exc:  # noqa: BLE001
        checks["redis"] = f"error: {exc.__class__.__name__}"
    healthy = checks.get("postgres") == "ok" and checks.get("redis") == "ok"
    return {
        "status": "ok" if healthy else "degraded",
        "env": settings.app_env,
        "auth": "enabled" if settings.api_auth_token else "disabled",
        "checks": checks,
        "ws_clients": manager.count,
    }


@app.websocket("/ws/live")
async def ws_live(ws: WebSocket):
    """Live feed. Sends hello on connect, heartbeats, and alert/sighting/alert_ack
    frames. Accepts {type:'subscribe',topics:[...]} and {type:'ping'}."""
    await manager.connect(ws)
    await ws.send_text(json.dumps({
        "type": "hello", "schema_version": 1, "server_time": _now(),
        "subscriber_count": manager.count,
    }))

    async def heartbeat():
        while True:
            await asyncio.sleep(25)
            try:
                await ws.send_text(json.dumps({"type": "heartbeat", "server_time": _now()}))
            except Exception:  # noqa: BLE001
                break

    hb = asyncio.create_task(heartbeat())
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:  # noqa: BLE001
                continue
            if msg.get("type") == "subscribe":
                await manager.set_topics(ws, msg.get("topics", []))
            elif msg.get("type") == "ping":
                await ws.send_text(json.dumps({"type": "heartbeat", "server_time": _now()}))
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        pass
    finally:
        hb.cancel()
        await manager.disconnect(ws)
