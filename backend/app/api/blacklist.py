"""Blacklist management: list (paginated), create, patch."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..audit import record_audit
from ..db import fetch_all, fetch_one
from ._common import iso, normalize_plate, operator_subject, paginate

router = APIRouter(tags=["blacklist"])

Severity = Literal["low", "medium", "high", "critical"]
BlacklistStatus = Literal["active", "inactive", "expired"]

_SELECT = """
    SELECT b.blacklist_entry_id::text AS blacklist_entry_id,
           b.plate_id::text           AS plate_id,
           p.normalized_plate,
           b.reason, b.severity, b.status,
           b.active_from, b.active_until, b.added_by, b.case_reference,
           (SELECT count(*) FROM sightings s WHERE s.plate_id = b.plate_id) AS sighting_count,
           (SELECT max(spotted_at) FROM sightings s WHERE s.plate_id = b.plate_id) AS last_seen_at
    FROM blacklist_entries b
    JOIN plates p ON p.plate_id = b.plate_id
"""


def _row(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "blacklist_entry_id": r["blacklist_entry_id"],
        "plate_id": r["plate_id"],
        "normalized_plate": r["normalized_plate"],
        "reason": r["reason"],
        "severity": r["severity"],
        "status": r["status"],
        "active_from": iso(r["active_from"]),
        "active_until": iso(r["active_until"]),
        "added_by": r["added_by"],
        "case_reference": r["case_reference"],
        "sighting_count": r["sighting_count"],
        "last_seen_at": iso(r["last_seen_at"]),
    }


async def _load(entry_id: str) -> dict[str, Any] | None:
    r = await fetch_one(_SELECT + " WHERE b.blacklist_entry_id = %(id)s", {"id": entry_id})
    return _row(r) if r else None


@router.get("/blacklist")
async def list_blacklist(
    status: list[str] | None = Query(None),
    severity: list[str] | None = Query(None),
    q: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    where = """
        WHERE (%(status)s::text[]   IS NULL OR b.status = ANY(%(status)s))
          AND (%(severity)s::text[] IS NULL OR b.severity = ANY(%(severity)s))
          AND (%(q)s::text IS NULL OR p.normalized_plate LIKE %(q)s OR b.reason ILIKE %(q)s)
    """
    qn = normalize_plate(q)
    params = {
        "status": status or None,
        "severity": severity or None,
        "q": (f"%{qn}%" if qn else None),
    }
    total = await fetch_one(f"SELECT count(*) AS n FROM ({_SELECT} {where}) t", params)
    rows = await fetch_all(
        f"{_SELECT} {where} ORDER BY b.active_from DESC LIMIT %(limit)s OFFSET %(offset)s",
        {**params, "limit": limit, "offset": offset},
    )
    return paginate([_row(r) for r in rows], total["n"] if total else 0, limit, offset)


class CreateBlacklistEntry(BaseModel):
    plate: str
    reason: str
    severity: Severity
    active_from: datetime | None = None
    active_until: datetime | None = None
    added_by: str
    case_reference: str | None = None


@router.post("/blacklist", status_code=201)
async def create_blacklist(
    body: CreateBlacklistEntry, operator: str = Depends(operator_subject)
) -> dict[str, Any]:
    norm = normalize_plate(body.plate)
    if not norm:
        raise HTTPException(status_code=422, detail="Invalid plate")
    plate = await fetch_one(
        """
        INSERT INTO plates (normalized_plate) VALUES (%(p)s)
        ON CONFLICT (normalized_plate) DO UPDATE SET normalized_plate = EXCLUDED.normalized_plate
        RETURNING plate_id::text AS plate_id
        """,
        {"p": norm},
    )
    created = await fetch_one(
        """
        INSERT INTO blacklist_entries
            (plate_id, reason, severity, status, active_from, active_until, added_by, case_reference)
        VALUES (%(plate_id)s, %(reason)s, %(severity)s, 'active',
                COALESCE(%(active_from)s, now()), %(active_until)s, %(added_by)s, %(case_reference)s)
        RETURNING blacklist_entry_id::text AS blacklist_entry_id
        """,
        {
            "plate_id": plate["plate_id"], "reason": body.reason, "severity": body.severity,
            "active_from": body.active_from, "active_until": body.active_until,
            "added_by": body.added_by or operator, "case_reference": body.case_reference,
        },
    )
    await record_audit(user_subject=body.added_by or operator, action="blacklist_create",
                       target_type="blacklist_entry", target_id=created["blacklist_entry_id"],
                       metadata={"plate": norm, "severity": body.severity})
    return await _load(created["blacklist_entry_id"])  # type: ignore[return-value]


class UpdateBlacklistEntry(BaseModel):
    status: BlacklistStatus | None = None
    severity: Severity | None = None
    reason: str | None = None
    active_until: datetime | None = None


@router.patch("/blacklist/{entry_id}")
async def update_blacklist(
    entry_id: str, body: UpdateBlacklistEntry, operator: str = Depends(operator_subject)
) -> dict[str, Any]:
    set_active_until = "active_until" in body.model_fields_set
    updated = await fetch_one(
        """
        UPDATE blacklist_entries SET
            status   = COALESCE(%(status)s, status),
            severity = COALESCE(%(severity)s, severity),
            reason   = COALESCE(%(reason)s, reason),
            active_until = CASE WHEN %(set_active_until)s THEN %(active_until)s ELSE active_until END
        WHERE blacklist_entry_id = %(id)s
        RETURNING blacklist_entry_id::text AS blacklist_entry_id
        """,
        {
            "id": entry_id, "status": body.status, "severity": body.severity,
            "reason": body.reason, "set_active_until": set_active_until,
            "active_until": body.active_until,
        },
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Blacklist entry not found")
    await record_audit(user_subject=operator, action="blacklist_update",
                       target_type="blacklist_entry", target_id=entry_id,
                       metadata=body.model_dump(exclude_unset=True, mode="json"))
    return await _load(entry_id)  # type: ignore[return-value]
