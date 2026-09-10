"""Plate typeahead search. Trajectory reconstruction lives in trajectory.py."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from ..db import fetch_all
from ._common import iso, normalize_plate

router = APIRouter(tags=["plates"])

_SEARCH_SQL = """
    SELECT p.plate_id::text AS plate_id,
           p.normalized_plate,
           (SELECT count(*) FROM sightings s WHERE s.plate_id = p.plate_id) AS sighting_count,
           (SELECT max(spotted_at) FROM sightings s WHERE s.plate_id = p.plate_id) AS last_seen_at,
           EXISTS (SELECT 1 FROM blacklist_entries b
                    WHERE b.plate_id = p.plate_id AND b.status = 'active') AS is_blacklisted
    FROM plates p
    WHERE p.normalized_plate LIKE %(prefix)s OR p.normalized_plate LIKE %(substr)s
    ORDER BY (p.normalized_plate LIKE %(prefix)s) DESC, p.normalized_plate
    LIMIT %(limit)s
"""


@router.get("/plates/search")
async def search_plates(
    q: str = Query(..., description="plate query"),
    limit: int = Query(10, ge=1, le=50),
) -> list[dict[str, Any]]:
    norm = normalize_plate(q)
    # A one-character query returns nothing (matches the mock's behaviour).
    if not norm or len(norm) < 2:
        return []
    rows = await fetch_all(
        _SEARCH_SQL, {"prefix": f"{norm}%", "substr": f"%{norm}%", "limit": limit}
    )
    return [
        {
            "plate_id": r["plate_id"],
            "normalized_plate": r["normalized_plate"],
            "sighting_count": r["sighting_count"],
            "last_seen_at": iso(r["last_seen_at"]),
            "is_blacklisted": r["is_blacklisted"],
        }
        for r in rows
    ]
