from __future__ import annotations
import psycopg

from datetime import datetime
from typing import Any


def get_recent_sightings(conn, since: datetime):
    """
    Return accepted sightings from the recent window.

    We intentionally query a recent time range rather than maintaining
    a separate worker cursor. The alerts.dedup_key UNIQUE constraint
    makes repeated processing safe.
    """

    with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        cur.execute(
            """
            SELECT
                s.sighting_id,
                s.source_event_id,
                s.camera_id,
                c.camera_code,
                s.plate_id,
                p.normalized_plate,
                s.spotted_at,
                s.detection_confidence,
                s.ocr_confidence
            FROM sightings s
            JOIN cameras c
              ON c.camera_id = s.camera_id
            LEFT JOIN plates p
              ON p.plate_id = s.plate_id
            WHERE s.validation_status = 'accepted'
              AND s.spotted_at >= %s
            ORDER BY s.spotted_at ASC
            """,
            (since,),
        )
        return cur.fetchall()


def get_previous_sighting(conn, plate_id, sighting_id):
    """
    Find the immediately preceding accepted sighting for the same plate.
    """

    if plate_id is None:
        return None

    with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        cur.execute(
            """
            SELECT
                s.sighting_id,
                s.camera_id,
                c.camera_code,
                s.spotted_at
            FROM sightings s
            JOIN cameras c
              ON c.camera_id = s.camera_id
            WHERE s.plate_id = %s
              AND s.validation_status = 'accepted'
              AND s.sighting_id <> %s
              AND s.spotted_at < (
                  SELECT spotted_at
                  FROM sightings
                  WHERE sighting_id = %s
              )
            ORDER BY s.spotted_at DESC
            LIMIT 1
            """,
            (plate_id, sighting_id, sighting_id),
        )
        return cur.fetchone()


def get_camera_link(conn, from_camera_id, to_camera_id):
    """
    Return the directed camera link, if one exists.
    """

    with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        cur.execute(
            """
            SELECT
                camera_link_id,
                from_camera_id,
                to_camera_id,
                distance_meters,
                free_flow_time_seconds,
                speed_limit_kph,
                direction_label
            FROM camera_links
            WHERE from_camera_id = %s
              AND to_camera_id = %s
              AND active = true
            LIMIT 1
            """,
            (from_camera_id, to_camera_id),
        )
        return cur.fetchone()


def get_reverse_camera_link(conn, from_camera_id, to_camera_id):
    """
    Check whether the opposite directed edge exists.

    Example:
        observed: CAM02 -> CAM01
        existing: CAM01 -> CAM02

    This is useful for detecting wrong-direction travel.
    """

    return get_camera_link(conn, to_camera_id, from_camera_id)


def get_active_blacklist_entry(conn, plate_id, spotted_at):
    """
    Return an active blacklist entry applicable at the sighting time.
    """

    if plate_id is None:
        return None

    with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        cur.execute(
            """
            SELECT
                blacklist_entry_id,
                reason,
                severity,
                status,
                active_from,
                active_until
            FROM blacklist_entries
            WHERE plate_id = %s
              AND status = 'active'
              AND active_from <= %s
              AND (
                  active_until IS NULL
                  OR active_until >= %s
              )
            ORDER BY
                CASE severity
                    WHEN 'critical' THEN 1
                    WHEN 'high' THEN 2
                    WHEN 'medium' THEN 3
                    WHEN 'low' THEN 4
                END
            LIMIT 1
            """,
            (plate_id, spotted_at, spotted_at),
        )
        return cur.fetchone()


def insert_alert(
    conn,
    *,
    dedup_key: str,
    alert_type: str,
    sighting_id,
    previous_sighting_id=None,
    blacklist_entry_id=None,
    anomaly_reason=None,
    match_confidence=None,
    details: dict[str, Any] | None = None,
):
    """
    Insert an alert.

    Returns the alert_id if a new alert was inserted.
    Returns None if the dedup_key already exists.
    """

    with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        cur.execute(
            """
            INSERT INTO alerts (
                dedup_key,
                alert_type,
                sighting_id,
                previous_sighting_id,
                blacklist_entry_id,
                anomaly_reason,
                match_confidence,
                details
            )
            VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s::jsonb
            )
            ON CONFLICT (dedup_key)
            DO NOTHING
            RETURNING alert_id::text
            """,
            (
                dedup_key,
                alert_type,
                sighting_id,
                previous_sighting_id,
                blacklist_entry_id,
                anomaly_reason,
                match_confidence,
                __import__("json").dumps(details or {}),
            ),
        )

        row = cur.fetchone()

        if row is None:
            return None

        return row["alert_id"]