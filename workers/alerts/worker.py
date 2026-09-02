from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timedelta, timezone

import psycopg
import redis

from .config import (
    ALERTS_CHANNEL,
    DATABASE_URL,
    LOOKBACK_MINUTES,
    POLL_INTERVAL_SECONDS,
    REDIS_URL,
)
from .db import (
    get_previous_sighting,
    get_recent_sightings,
    insert_alert,
)
from .rules import blacklist_alert, route_anomaly_alert


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

logger = logging.getLogger("anpr.alerts")


def create_redis_client():
    return redis.Redis.from_url(
        REDIS_URL,
        decode_responses=True,
    )


def publish_alert(redis_client, alert_id: str):
    """
    Publish ONLY the alert_id.

    backend/app/realtime.py subscribes to alerts:new,
    loads the authoritative alert from PostgreSQL,
    and sends it over WebSocket.
    """

    redis_client.publish(
        ALERTS_CHANNEL,
        alert_id,
    )


def process_sighting(conn, redis_client, sighting):
    """
    Evaluate one accepted sighting against all Lane C alert rules.
    """

    logger.info(
        "Processing sighting=%s plate=%s camera=%s",
        sighting["sighting_id"],
        sighting["normalized_plate"],
        sighting["camera_code"],
    )

    alerts_to_create = []

    # ---------------------------------------------------------
    # 1. BLACKLIST
    # ---------------------------------------------------------

    blacklist = blacklist_alert(
        conn,
        sighting,
    )

    if blacklist is not None:
        alerts_to_create.append(blacklist)

    # ---------------------------------------------------------
    # 2. ROUTE ANOMALY
    # ---------------------------------------------------------

    previous = get_previous_sighting(
        conn,
        sighting["plate_id"],
        sighting["sighting_id"],
    )

    anomaly = route_anomaly_alert(
        conn,
        sighting,
        previous,
    )

    if anomaly is not None:
        alerts_to_create.append(anomaly)

    # ---------------------------------------------------------
    # 3. WRITE + PUBLISH
    # ---------------------------------------------------------

    for alert in alerts_to_create:
        alert_id = insert_alert(
            conn,
            dedup_key=alert["dedup_key"],
            alert_type=alert["alert_type"],
            sighting_id=sighting["sighting_id"],
            previous_sighting_id=alert.get(
                "previous_sighting_id"
            ),
            blacklist_entry_id=alert.get(
                "blacklist_entry_id"
            ),
            anomaly_reason=alert.get(
                "anomaly_reason"
            ),
            match_confidence=alert.get(
                "match_confidence"
            ),
            details=alert.get("details"),
        )

        if alert_id is None:
            logger.info(
                "[DEDUP] alert already exists dedup_key=%s",
                alert["dedup_key"],
            )
            continue

        conn.commit()

        logger.info(
            "[ALERT] id=%s type=%s reason=%s",
            alert_id,
            alert["alert_type"],
            alert.get("anomaly_reason"),
        )

        try:
            publish_alert(
                redis_client,
                alert_id,
            )

            logger.info(
                "[PUBLISHED] alert_id=%s channel=%s",
                alert_id,
                ALERTS_CHANNEL,
            )

        except Exception:
            # The alert is already safely stored in PostgreSQL.
            # The API can still retrieve it through GET /alerts.
            logger.exception(
                "[WARN] failed to publish alert_id=%s",
                alert_id,
            )


def main():
    print("Starting alerts worker...")

    redis_client = create_redis_client()
    print("Redis client created")

    with psycopg.connect(DATABASE_URL) as conn:
        print("PostgreSQL connection successful")
        print("Waiting for accepted sightings...")

        while True:
            try:
                process_cycle(
                    conn,
                    redis_client,
                )

            except KeyboardInterrupt:
                print("Stopping alerts worker...")
                break

            except Exception:
                logger.exception(
                    "Alert worker cycle failed"
                )

            time.sleep(POLL_INTERVAL_SECONDS)

    redis_client.close()


def process_cycle(conn, redis_client):
    """
    Process a recent sliding window of accepted sightings.

    Reprocessing is safe because alerts.dedup_key is UNIQUE.
    """

    since = (
        datetime.now(timezone.utc)
        - timedelta(minutes=LOOKBACK_MINUTES)
    )

    sightings = get_recent_sightings(
        conn,
        since,
    )

    if not sightings:
        return

    logger.info(
        "Found %d accepted sightings in recent window",
        len(sightings),
    )

    for sighting in sightings:
        try:
            process_sighting(
                conn,
                redis_client,
                sighting,
            )

        except Exception:
            conn.rollback()

            logger.exception(
                "[RETRY] sighting=%s failed",
                sighting["sighting_id"],
            )


if __name__ == "__main__":
    main()