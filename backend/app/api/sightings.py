"""GET /sightings -> Paginated<Sighting> with filters."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Query

from ..db import fetch_all, fetch_one
from ._common import SIGHTING_SELECT, normalize_plate, paginate, sighting_row_to_dict

router = APIRouter(tags=["sightings"])

_WHERE = """
    WHERE (%(camera_code)s::text IS NULL OR sc.camera_code = %(camera_code)s)
      AND (%(plate)s::text       IS NULL OR p.normalized_plate = %(plate)s)
      AND (%(vstatus)s::text[]   IS NULL OR s.validation_status = ANY(%(vstatus)s))
      AND (%(from_ts)s::timestamptz IS NULL OR s.spotted_at >= %(from_ts)s)
      AND (%(to_ts)s::timestamptz   IS NULL OR s.spotted_at <= %(to_ts)s)
"""


@router.get("/sightings")
async def list_sightings(
    camera_code: str | None = Query(None),
    plate: str | None = Query(None),
    validation_status: list[str] | None = Query(None),
    from_ts: datetime | None = Query(None, alias="from"),
    to_ts: datetime | None = Query(None, alias="to"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    params = {
        "camera_code": camera_code,
        "plate": normalize_plate(plate),
        "vstatus": validation_status or None,
        "from_ts": from_ts,
        "to_ts": to_ts,
    }
    total = await fetch_one(f"SELECT count(*) AS n FROM ({SIGHTING_SELECT} {_WHERE}) t", params)
    rows = await fetch_all(
        f"{SIGHTING_SELECT} {_WHERE} ORDER BY s.spotted_at DESC LIMIT %(limit)s OFFSET %(offset)s",
        {**params, "limit": limit, "offset": offset},
    )
    return paginate([sighting_row_to_dict(r) for r in rows], total["n"] if total else 0, limit, offset)
