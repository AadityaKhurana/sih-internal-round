"""Real-time delivery for /ws/live.

Topic-aware connection manager + two Redis subscribers (alerts, sightings). The
alerts worker publishes an alert_id to `alerts:new`; a live/persistence worker
publishes a sighting_id (or a LiveSighting JSON) to `sightings:new`. We load the
full row and fan it out to subscribed clients in the contract's frame shape.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging

import redis.asyncio as aioredis
from fastapi import WebSocket

from .api._common import iso, load_alert
from .db import fetch_one

logger = logging.getLogger("anpr.realtime")

ALERTS_CHANNEL = "alerts:new"
SIGHTINGS_CHANNEL = "sightings:new"
DEFAULT_TOPICS = ("alerts", "sightings")


class ConnectionManager:
    """Tracks WebSocket clients and the topics each subscribed to."""

    def __init__(self) -> None:
        self._conns: dict[WebSocket, set[str]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._conns[ws] = set(DEFAULT_TOPICS)

    async def set_topics(self, ws: WebSocket, topics: list[str]) -> None:
        async with self._lock:
            if ws in self._conns:
                self._conns[ws] = {t for t in topics if t in DEFAULT_TOPICS} or set(DEFAULT_TOPICS)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._conns.pop(ws, None)

    async def broadcast_json(self, topic: str, obj: dict) -> None:
        message = json.dumps(obj)
        async with self._lock:
            targets = [ws for ws, topics in self._conns.items() if topic in topics]
        dead: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_text(message)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._conns.pop(ws, None)

    @property
    def count(self) -> int:
        return len(self._conns)


manager = ConnectionManager()

_LIVE_SIGHTING_SQL = """
    SELECT s.sighting_id::text     AS sighting_id,
           sc.camera_code          AS camera_code,
           sc.display_name         AS camera_display_name,
           ST_X(sc.location)::float8 AS lng,
           ST_Y(sc.location)::float8 AS lat,
           p.normalized_plate      AS normalized_plate,
           s.spotted_at            AS spotted_at,
           s.validation_status     AS validation_status,
           s.ocr_confidence::float8 AS ocr_confidence,
           s.vehicle_type          AS vehicle_type
    FROM sightings s
    JOIN cameras sc ON sc.camera_id = s.camera_id
    LEFT JOIN plates p ON p.plate_id = s.plate_id
    WHERE s.sighting_id = %(id)s
"""


async def _load_live_sighting(sighting_id: str) -> dict | None:
    r = await fetch_one(_LIVE_SIGHTING_SQL, {"id": sighting_id})
    if r is None:
        return None
    return {
        "sighting_id": r["sighting_id"],
        "camera_code": r["camera_code"],
        "camera_display_name": r["camera_display_name"],
        "camera_location": [r["lng"], r["lat"]],
        "normalized_plate": r["normalized_plate"],
        "spotted_at": iso(r["spotted_at"]),
        "validation_status": r["validation_status"],
        "ocr_confidence": r["ocr_confidence"],
        "vehicle_type": r["vehicle_type"],
    }


def _decode(data) -> str:
    return data.decode() if isinstance(data, bytes) else str(data)


async def alerts_subscriber(redis_url: str, stop: asyncio.Event) -> None:
    r = aioredis.from_url(redis_url)
    pubsub = r.pubsub()
    await pubsub.subscribe(ALERTS_CHANNEL)
    logger.info("live publisher subscribed to %s", ALERTS_CHANNEL)
    try:
        while not stop.is_set():
            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if msg is None:
                continue
            alert_id = _decode(msg["data"]).strip().strip('"')
            try:
                alert = await load_alert(alert_id)
                if alert is None:
                    logger.warning("published alert_id %s not found", alert_id)
                    continue
                await manager.broadcast_json("alerts", {"type": "alert", "alert": alert})
            except Exception:  # noqa: BLE001
                logger.exception("failed to broadcast alert %s", alert_id)
    finally:
        with contextlib.suppress(Exception):
            await pubsub.unsubscribe(ALERTS_CHANNEL)
            await pubsub.aclose()
            await r.aclose()


async def sightings_subscriber(redis_url: str, stop: asyncio.Event) -> None:
    r = aioredis.from_url(redis_url)
    pubsub = r.pubsub()
    await pubsub.subscribe(SIGHTINGS_CHANNEL)
    logger.info("live publisher subscribed to %s", SIGHTINGS_CHANNEL)
    try:
        while not stop.is_set():
            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if msg is None:
                continue
            payload = _decode(msg["data"]).strip()
            try:
                sighting = None
                if payload.startswith("{"):
                    sighting = json.loads(payload)  # already a LiveSighting
                else:
                    sighting = await _load_live_sighting(payload.strip('"'))
                if sighting is None:
                    continue
                await manager.broadcast_json("sightings", {"type": "sighting", "sighting": sighting})
            except Exception:  # noqa: BLE001
                logger.exception("failed to broadcast sighting")
    finally:
        with contextlib.suppress(Exception):
            await pubsub.unsubscribe(SIGHTINGS_CHANNEL)
            await pubsub.aclose()
            await r.aclose()
