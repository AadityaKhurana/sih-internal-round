"""Alerts API — full contract shape.

GET /alerts            -> Paginated<Alert>   (rich filters)
GET /alerts/counts     -> AlertCounts
POST /alerts/{id}/acknowledge -> Alert       (audited; broadcasts alert_ack)
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..audit import record_audit
from ..db import fetch_all, fetch_one
from ._common import (
    ALERT_SELECT,
    alert_row_to_dict,
    iso,
    load_alert,
    operator_subject,
    paginate,
)

router = APIRouter(tags=["alerts"])

_WHERE = """
    WHERE (%(alert_type)s::text[]     IS NULL OR a.alert_type = ANY(%(alert_type)s))
      AND (%(status)s::text[]         IS NULL OR a.status = ANY(%(status)s))
      AND (%(severity)s::text[]       IS NULL OR b.severity = ANY(%(severity)s))
      AND (%(anomaly_reason)s::text[] IS NULL OR a.anomaly_reason = ANY(%(anomaly_reason)s))
      AND (%(plate)s::text            IS NULL OR p.normalized_plate = %(plate)s)
      AND (%(camera_code)s::text      IS NULL OR sc.camera_code = %(camera_code)s)
      AND (%(from_ts)s::timestamptz   IS NULL OR a.created_at >= %(from_ts)s)
      AND (%(to_ts)s::timestamptz     IS NULL OR a.created_at <= %(to_ts)s)
"""


def _norm(plate: str | None) -> str | None:
    if plate is None:
        return None
    return "".join(ch for ch in plate.upper() if ch.isalnum()) or None


def _filters(alert_type, status, severity, anomaly_reason, plate, camera_code, from_ts, to_ts):
    return {
        "alert_type": alert_type or None,
        "status": status or None,
        "severity": severity or None,
        "anomaly_reason": anomaly_reason or None,
        "plate": _norm(plate),
        "camera_code": camera_code,
        "from_ts": from_ts,
        "to_ts": to_ts,
    }


@router.get("/alerts")
async def list_alerts(
    alert_type: list[str] | None = Query(None),
    status: list[str] | None = Query(None),
    severity: list[str] | None = Query(None),
    anomaly_reason: list[str] | None = Query(None),
    plate: str | None = Query(None),
    camera_code: str | None = Query(None),
    from_ts: datetime | None = Query(None, alias="from"),
    to_ts: datetime | None = Query(None, alias="to"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    f = _filters(alert_type, status, severity, anomaly_reason, plate, camera_code, from_ts, to_ts)
    total_row = await fetch_one(f"SELECT count(*) AS n FROM ({ALERT_SELECT} {_WHERE}) t", f)
    rows = await fetch_all(
        f"{ALERT_SELECT} {_WHERE} ORDER BY a.created_at DESC LIMIT %(limit)s OFFSET %(offset)s",
        {**f, "limit": limit, "offset": offset},
    )
    items = [alert_row_to_dict(r) for r in rows]
    return paginate(items, total_row["n"] if total_row else 0, limit, offset)


@router.get("/alerts/counts")
async def alert_counts(
    from_ts: datetime | None = Query(None, alias="from"),
    to_ts: datetime | None = Query(None, alias="to"),
) -> dict[str, Any]:
    f = _filters(None, None, None, None, None, None, from_ts, to_ts)
    rows = await fetch_all(
        f"""
        SELECT a.status, a.alert_type, a.anomaly_reason, b.severity
        FROM alerts a
        JOIN sightings s ON s.sighting_id = a.sighting_id
        JOIN cameras sc ON sc.camera_id = s.camera_id
        LEFT JOIN plates p ON p.plate_id = s.plate_id
        LEFT JOIN blacklist_entries b ON b.blacklist_entry_id = a.blacklist_entry_id
        {_WHERE}
        """,
        f,
    )
    sev = {k: 0 for k in ("low", "medium", "high", "critical")}
    anom = {k: 0 for k in ("impossible_travel_time", "wrong_direction", "suspected_clone")}
    counts = {"total": len(rows), "new": 0, "acknowledged": 0, "resolved": 0,
              "blacklist": 0, "route_anomaly": 0}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
        counts[r["alert_type"]] = counts.get(r["alert_type"], 0) + 1
        if r["severity"] in sev:
            sev[r["severity"]] += 1
        if r["anomaly_reason"] in anom:
            anom[r["anomaly_reason"]] += 1
    counts["by_severity"] = sev
    counts["by_anomaly_reason"] = anom
    return counts


class AcknowledgeRequest(BaseModel):
    acknowledged_by: str
    resolution_notes: str | None = None
    status: str = "acknowledged"  # 'acknowledged' | 'resolved'


@router.post("/alerts/{alert_id}/acknowledge")
async def acknowledge_alert(
    alert_id: str,
    body: AcknowledgeRequest,
    operator: str = Depends(operator_subject),
) -> dict[str, Any]:
    if body.status not in ("acknowledged", "resolved"):
        raise HTTPException(status_code=422, detail="status must be acknowledged or resolved")
    subject = body.acknowledged_by or operator
    updated = await fetch_one(
        """
        UPDATE alerts
        SET status = %(status)s, acknowledged_at = now(), acknowledged_by = %(by)s,
            resolution_notes = COALESCE(%(notes)s, resolution_notes)
        WHERE alert_id = %(id)s
        RETURNING alert_id::text AS alert_id, acknowledged_at
        """,
        {"id": alert_id, "status": body.status, "by": subject, "notes": body.resolution_notes},
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Alert not found")

    await record_audit(
        user_subject=subject, action="alert_acknowledge",
        target_type="alert", target_id=alert_id,
        metadata={"status": body.status, "resolution_notes": body.resolution_notes},
    )

    alert = await load_alert(alert_id)
    # Best-effort live notification (same-process manager).
    try:
        from ..realtime import manager
        await manager.broadcast_json("alerts", {
            "type": "alert_ack", "alert_id": alert_id, "status": body.status,
            "acknowledged_by": subject, "acknowledged_at": iso(updated["acknowledged_at"]),
        })
    except Exception:  # noqa: BLE001
        pass
    return alert  # type: ignore[return-value]
