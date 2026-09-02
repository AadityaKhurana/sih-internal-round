"""Real-time delivery: the API's "live publisher".

An alerts worker (separate process) writes an alert to Postgres and PUBLISHes the
alert_id to a Redis channel. This task subscribes to that channel, loads the full
alert from the DB, and broadcasts it to every connected WebSocket client.

The WebSocket endpoint itself is unauthenticated for now — see NOTE(auth).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging

import redis.asyncio as aioredis
from fastapi import WebSocket

from .api.alerts import _ONE_SQL, _row_to_alert
from .db import fetch_one

logger = logging.getLogger("anpr.realtime")

# Must match anpr_common.channels.ALERTS_CHANNEL (the alerts worker publishes here).
# Duplicated locally because the API image does not yet install the common package.
ALERTS_CHANNEL = "alerts:new"


class ConnectionManager:
    """Tracks active WebSocket clients and broadcasts to all of them."""

    def __init__(self) -> None:
        self._conns: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._conns.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._conns.discard(ws)

    async def broadcast(self, message: str) -> None:
        async with self._lock:
            targets = list(self._conns)
        dead: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_text(message)
            except Exception:  # noqa: BLE001 - drop broken sockets
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._conns.discard(ws)

    @property
    def count(self) -> int:
        return len(self._conns)


manager = ConnectionManager()


async def alerts_subscriber(redis_url: str, stop: asyncio.Event) -> None:
    """Subscribe to ALERTS_CHANNEL; for each alert_id, load + broadcast the alert."""
    r = aioredis.from_url(redis_url)
    pubsub = r.pubsub()
    await pubsub.subscribe(ALERTS_CHANNEL)
    logger.info("live publisher subscribed to %s", ALERTS_CHANNEL)
    try:
        while not stop.is_set():
            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if msg is None:
                continue
            alert_id = msg["data"]
            if isinstance(alert_id, bytes):
                alert_id = alert_id.decode()
            alert_id = alert_id.strip().strip('"')
            try:
                row = await fetch_one(_ONE_SQL, {"alert_id": alert_id})
                if row is None:
                    logger.warning("published alert_id %s not found in DB", alert_id)
                    continue
                payload = _row_to_alert(row).model_dump(mode="json")
                await manager.broadcast(json.dumps({"type": "alert", "data": payload}))
            except Exception:  # noqa: BLE001 - one bad message must not kill the loop
                logger.exception("failed to broadcast alert %s", alert_id)
    finally:
        with contextlib.suppress(Exception):
            await pubsub.unsubscribe(ALERTS_CHANNEL)
            await pubsub.aclose()
            await r.aclose()
