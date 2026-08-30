"""Alerts API: list/filter, fetch one, and acknowledge.

Alerts are produced by the alerts worker (blacklist + route-anomaly). This
module only reads them and lets an operator acknowledge — it does not generate
alerts. Acknowledgement is audited.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from ..audit import record_audit
from ..db import fetch_all, fetch_one
from ..schemas import AcknowledgeRequest, AlertOut, AlertSightingRef

router = APIRouter(tags=["alerts"])

_SELECT = """
    SELECT a.alert_id::text        AS alert_id,
           a.alert_type, a.status, a.anomaly_reason,
           a.match_confidence::float8 AS match_confidence,
           a.dedup_key, a.details,
           a.created_at, a.delivered_at, a.acknowledged_at, a.acknowledged_by,
           a.resolution_notes,
           p.normalized_plate       AS plate,
           b.reason                 AS blacklist_reason,
           b.severity               AS severity,
           s.sighting_id::text      AS s_sighting_id,
           sc.camera_code           AS s_camera_code,
           sc.display_name          AS s_display_name,
           s.spotted_at             AS s_spotted_at,
           ps.sighting_id::text     AS p_sighting_id,
           pc.camera_code           AS p_camera_code,
           pc.display_name          AS p_display_name,
           ps.spotted_at            AS p_spotted_at
    FROM alerts a
    JOIN sightings s  ON s.sighting_id = a.sighting_id
    JOIN cameras   sc ON sc.camera_id = s.camera_id
    LEFT JOIN plates p            ON p.plate_id = s.plate_id
    LEFT JOIN blacklist_entries b ON b.blacklist_entry_id = a.blacklist_entry_id
    LEFT JOIN sightings ps        ON ps.sighting_id = a.previous_sighting_id
    LEFT JOIN cameras   pc        ON pc.camera_id = ps.camera_id
"""

_LIST_SQL = _SELECT + """
    WHERE (%(status)s::text IS NULL OR a.status = %(status)s)
      AND (%(alert_type)s::text IS NULL OR a.alert_type = %(alert_type)s)
    ORDER BY a.created_at DESC
    LIMIT %(limit)s OFFSET %(offset)s
"""

_ONE_SQL = _SELECT + " WHERE a.alert_id = %(alert_id)s"


def _row_to_alert(row: dict[str, Any]) -> AlertOut:
    prev = None
    if row["p_sighting_id"] is not None:
        prev = AlertSightingRef(
            sighting_id=row["p_sighting_id"],
            camera_code=row["p_camera_code"],
            display_name=row["p_display_name"],
            spotted_at=row["p_spotted_at"],
        )
    return AlertOut(
        alert_id=row["alert_id"],
        alert_type=row["alert_type"],
        status=row["status"],
        anomaly_reason=row["anomaly_reason"],
        match_confidence=row["match_confidence"],
        dedup_key=row["dedup_key"],
        plate=row["plate"],
        severity=row["severity"],
        blacklist_reason=row["blacklist_reason"],
        details=row["details"] or {},
        created_at=row["created_at"],
        delivered_at=row["delivered_at"],
        acknowledged_at=row["acknowledged_at"],
        acknowledged_by=row["acknowledged_by"],
        resolution_notes=row["resolution_notes"],
        sighting=AlertSightingRef(
            sighting_id=row["s_sighting_id"],
            camera_code=row["s_camera_code"],
            display_name=row["s_display_name"],
            spotted_at=row["s_spotted_at"],
        ),
        previous_sighting=prev,
    )


@router.get("/alerts", response_model=list[AlertOut])
async def list_alerts(
    status: str | None = Query(None, description="new | delivered | acknowledged | resolved"),
    alert_type: str | None = Query(None, description="blacklist | route_anomaly"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> list[AlertOut]:
    rows = await fetch_all(
        _LIST_SQL,
        {"status": status, "alert_type": alert_type, "limit": limit, "offset": offset},
    )
    return [_row_to_alert(r) for r in rows]


@router.get("/alerts/{alert_id}", response_model=AlertOut)
async def get_alert(alert_id: str) -> AlertOut:
    row = await fetch_one(_ONE_SQL, {"alert_id": alert_id})
    if row is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    return _row_to_alert(row)


@router.post("/alerts/{alert_id}/acknowledge", response_model=AlertOut)
async def acknowledge_alert(alert_id: str, body: AcknowledgeRequest) -> AlertOut:
    updated = await fetch_one(
        """
        UPDATE alerts
        SET status = 'acknowledged',
            acknowledged_at = now(),
            acknowledged_by = %(by)s,
            resolution_notes = COALESCE(%(notes)s, resolution_notes)
        WHERE alert_id = %(alert_id)s
        RETURNING alert_id::text AS alert_id
        """,
        {"alert_id": alert_id, "by": body.acknowledged_by, "notes": body.resolution_notes},
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Alert not found")

    await record_audit(
        user_subject=body.acknowledged_by,
        action="alert_acknowledge",
        target_type="alert",
        target_id=alert_id,
        metadata={"resolution_notes": body.resolution_notes},
    )

    row = await fetch_one(_ONE_SQL, {"alert_id": alert_id})
    return _row_to_alert(row)  # type: ignore[arg-type]
