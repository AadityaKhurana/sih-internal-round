"""Shared helpers for the API routers.

Centralizes: operator identity (header-based until real auth), the pagination
envelope, RFC-3339 formatting, and the canonical Alert query + row->dict shaper
(used by BOTH the /alerts endpoints and the /ws/live broadcaster, so the wire
shape can never diverge between REST and WebSocket).
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import Header

from ..db import fetch_all, fetch_one

OPERATOR_HEADER = "X-Operator-Subject"


async def operator_subject(
    x_operator_subject: str | None = Header(default=None, alias=OPERATOR_HEADER),
) -> str:
    """Operator identity for audit + acknowledged_by/added_by defaults.
    Placeholder until real auth; the client sends it on every request."""
    return (x_operator_subject or "").strip() or "unknown"


def iso(dt: datetime | None) -> str | None:
    """RFC 3339 with 'Z' (JSON-safe; usable in json.dumps for WS frames)."""
    if dt is None:
        return None
    return dt.isoformat().replace("+00:00", "Z")


def paginate(items: list[Any], total: int, limit: int, offset: int) -> dict[str, Any]:
    return {"items": items, "total": total, "limit": limit, "offset": offset}


# --- Alert: one shape for REST list/get/ack AND the WebSocket 'alert' frame ----
ALERT_SELECT = """
    SELECT a.alert_id::text            AS alert_id,
           a.dedup_key,
           a.alert_type,
           a.sighting_id::text         AS sighting_id,
           a.previous_sighting_id::text AS previous_sighting_id,
           a.blacklist_entry_id::text  AS blacklist_entry_id,
           a.anomaly_reason,
           a.match_confidence::float8  AS match_confidence,
           a.status,
           a.details,
           a.created_at, a.delivered_at, a.acknowledged_at, a.acknowledged_by,
           a.resolution_notes,
           p.normalized_plate          AS normalized_plate,
           sc.camera_code              AS camera_code,
           sc.display_name             AS camera_display_name,
           ST_X(sc.location)::float8   AS cam_lng,
           ST_Y(sc.location)::float8   AS cam_lat,
           s.spotted_at                AS spotted_at,
           s.plate_crop_object_key     AS plate_crop_object_key,
           b.severity                  AS severity,
           b.reason                    AS blacklist_reason,
           b.case_reference            AS case_reference,
           pc.camera_code              AS previous_camera_code,
           ps.spotted_at               AS previous_spotted_at
    FROM alerts a
    JOIN sightings s  ON s.sighting_id = a.sighting_id
    JOIN cameras   sc ON sc.camera_id = s.camera_id
    LEFT JOIN plates            p  ON p.plate_id = s.plate_id
    LEFT JOIN blacklist_entries b  ON b.blacklist_entry_id = a.blacklist_entry_id
    LEFT JOIN sightings         ps ON ps.sighting_id = a.previous_sighting_id
    LEFT JOIN cameras           pc ON pc.camera_id = ps.camera_id
"""


def alert_row_to_dict(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "alert_id": r["alert_id"],
        "dedup_key": r["dedup_key"],
        "alert_type": r["alert_type"],
        "sighting_id": r["sighting_id"],
        "previous_sighting_id": r["previous_sighting_id"],
        "blacklist_entry_id": r["blacklist_entry_id"],
        "anomaly_reason": r["anomaly_reason"],
        "match_confidence": r["match_confidence"],
        "status": r["status"],
        "details": r["details"] or {},
        "created_at": iso(r["created_at"]),
        "delivered_at": iso(r["delivered_at"]),
        "acknowledged_at": iso(r["acknowledged_at"]),
        "acknowledged_by": r["acknowledged_by"],
        "resolution_notes": r["resolution_notes"],
        "normalized_plate": r["normalized_plate"],
        "camera_code": r["camera_code"],
        "camera_display_name": r["camera_display_name"],
        "camera_location": [r["cam_lng"], r["cam_lat"]],
        "spotted_at": iso(r["spotted_at"]),
        "severity": r["severity"],
        "blacklist_reason": r["blacklist_reason"],
        "case_reference": r["case_reference"],
        "previous_camera_code": r["previous_camera_code"],
        "previous_spotted_at": iso(r["previous_spotted_at"]),
        "plate_crop_object_key": r["plate_crop_object_key"],
    }


async def load_alert(alert_id: str) -> dict[str, Any] | None:
    row = await fetch_one(ALERT_SELECT + " WHERE a.alert_id = %(id)s", {"id": alert_id})
    return alert_row_to_dict(row) if row else None


def normalize_plate(raw: str | None) -> str | None:
    if raw is None:
        return None
    return "".join(c for c in raw.upper() if c.isalnum()) or None


# --- Sighting: one shape for /sightings AND the trajectory endpoint -----------
SIGHTING_SELECT = """
    SELECT s.sighting_id::text          AS sighting_id,
           s.source_event_id,
           s.camera_id::text            AS camera_id,
           sc.camera_code,
           sc.display_name              AS camera_display_name,
           ST_X(sc.location)::float8    AS s_lng,
           ST_Y(sc.location)::float8    AS s_lat,
           s.plate_id::text             AS plate_id,
           p.normalized_plate           AS normalized_plate,
           s.raw_plate_text,
           s.normalized_plate_candidate,
           s.camera_track_id,
           s.detection_confidence::float8 AS detection_confidence,
           s.ocr_confidence::float8     AS ocr_confidence,
           s.ocr_candidates,
           s.validation_status,
           s.validation_reason,
           s.spotted_at,
           s.processed_at,
           s.direction_degrees::float8  AS direction_degrees,
           s.vehicle_type, s.vehicle_color, s.lane_number,
           s.quality_flags, s.model_version,
           s.plate_crop_object_key, s.vehicle_image_object_key, s.context_clip_object_key
    FROM sightings s
    JOIN cameras sc ON sc.camera_id = s.camera_id
    LEFT JOIN plates p ON p.plate_id = s.plate_id
"""


def sighting_row_to_dict(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "sighting_id": r["sighting_id"],
        "source_event_id": r["source_event_id"],
        "camera_id": r["camera_id"],
        "camera_code": r["camera_code"],
        "camera_display_name": r["camera_display_name"],
        "camera_location": [r["s_lng"], r["s_lat"]],
        "plate_id": r["plate_id"],
        "normalized_plate": r["normalized_plate"],
        "raw_plate_text": r["raw_plate_text"],
        "normalized_plate_candidate": r["normalized_plate_candidate"],
        "camera_track_id": r["camera_track_id"],
        "detection_confidence": r["detection_confidence"],
        "ocr_confidence": r["ocr_confidence"],
        "ocr_candidates": r["ocr_candidates"] or [],
        "validation_status": r["validation_status"],
        "validation_reason": r["validation_reason"],
        "spotted_at": iso(r["spotted_at"]),
        "processed_at": iso(r["processed_at"]),
        "direction_degrees": r["direction_degrees"],
        "vehicle_type": r["vehicle_type"],
        "vehicle_color": r["vehicle_color"],
        "lane_number": r["lane_number"],
        "quality_flags": r["quality_flags"] or {},
        "model_version": r["model_version"],
        "plate_crop_object_key": r["plate_crop_object_key"],
        "vehicle_image_object_key": r["vehicle_image_object_key"],
        "context_clip_object_key": r["context_clip_object_key"],
    }
