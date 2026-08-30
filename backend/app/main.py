import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

import redis.asyncio as aioredis
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .api import api_router
from .config import settings
from .db import close_pool, get_pool, open_pool
from .realtime import alerts_subscriber, manager
from .security import authorize_ws

logger = logging.getLogger("anpr.api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await open_pool()
    if not settings.api_auth_token:
        logger.warning("API_AUTH_TOKEN is not set — API auth is DISABLED (dev mode).")
    app.state.redis = aioredis.from_url(
        settings.redis_url, socket_connect_timeout=2, socket_timeout=2
    )
    # Live publisher: subscribe to the alerts channel and fan out to WebSocket clients.
    stop = asyncio.Event()
    subscriber = asyncio.create_task(alerts_subscriber(settings.redis_url, stop))
    try:
        yield
    finally:
        stop.set()
        subscriber.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await subscriber
        await app.state.redis.aclose()
        await close_pool()


app = FastAPI(title="City-Wide ANPR API", version="0.1.0", lifespan=lifespan)

# Dev CORS: the Leaflet frontend (Lane D) calls this API from a different origin.
# TODO(auth): tighten allow_origins before any real deploy.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)


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
    except Exception as exc:  # noqa: BLE001 - surface class name only
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


@app.websocket("/ws/alerts")
async def ws_alerts(ws: WebSocket, token: str | None = Query(default=None)):
    """Live alert feed. Auth via ?token=<API_AUTH_TOKEN> when auth is enabled.
    Clients receive {"type":"alert","data":{...}} messages as alerts are created."""
    if not await authorize_ws(ws, token):
        return
    await manager.connect(ws)
    try:
        # We don't expect inbound messages; this receive just detects disconnect.
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(ws)
    except Exception:  # noqa: BLE001
        await manager.disconnect(ws)
