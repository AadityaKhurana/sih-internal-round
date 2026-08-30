"""Plate trajectory reconstruction.

The core Lane B query: for a plate, take its accepted sightings in a time range,
order them chronologically, and stitch consecutive sightings into legs matched
against `camera_links` (so the frontend can draw the actual monitored path, not
just straight lines between points). Routes are reconstructed here, never stored.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from ..db import fetch_all, fetch_one
from ..schemas import GeoFeature, GeoFeatureCollection, TrajectoryLeg, TrajectoryResponse

router = APIRouter(tags=["trajectory"])

# Heuristic only — the alerts worker owns authoritative anomaly detection.
# A hop faster than 60% of the link's free-flow time is flagged as not feasible.
FEASIBLE_MIN_RATIO = 0.6


def normalize_plate(raw: str) -> str:
    """Basic normalization (uppercase, keep alphanumerics). The OCR worker owns
    the authoritative normalizer; this just makes lookups forgiving."""
    return "".join(ch for ch in raw.upper() if ch.isalnum())


_SIGHTINGS_SQL = """
    SELECT s.sighting_id::text        AS sighting_id,
           s.spotted_at,
           s.validation_status,
           s.direction_degrees::float8 AS direction_degrees,
           s.vehicle_type, s.vehicle_color, s.lane_number,
           s.ocr_confidence::float8   AS ocr_confidence,
           c.camera_id::text          AS camera_id,
           c.camera_code, c.display_name,
           ST_AsGeoJSON(c.location)::json AS geometry
    FROM sightings s
    JOIN cameras c ON c.camera_id = s.camera_id
    WHERE s.plate_id = %(plate_id)s
      AND s.validation_status = ANY(%(statuses)s)
      AND (%(from_ts)s::timestamptz IS NULL OR s.spotted_at >= %(from_ts)s)
      AND (%(to_ts)s::timestamptz   IS NULL OR s.spotted_at <= %(to_ts)s)
    ORDER BY s.spotted_at ASC
"""

_LINKS_SQL = """
    SELECT from_camera_id::text AS from_camera_id,
           to_camera_id::text   AS to_camera_id,
           distance_meters,
           free_flow_time_seconds,
           ST_AsGeoJSON(path)::json AS geometry
    FROM camera_links
    WHERE from_camera_id::text = ANY(%(cam_ids)s)
      AND to_camera_id::text   = ANY(%(cam_ids)s)
"""


@router.get("/plates/{plate}/trajectory", response_model=TrajectoryResponse)
async def plate_trajectory(
    plate: str,
    from_ts: datetime | None = Query(None, alias="from", description="ISO start time (inclusive)"),
    to_ts: datetime | None = Query(None, alias="to", description="ISO end time (inclusive)"),
    statuses: list[str] = Query(["accepted"], description="validation_status values to include"),
) -> TrajectoryResponse:
    normalized = normalize_plate(plate)
    plate_row = await fetch_one(
        "SELECT plate_id::text AS plate_id FROM plates WHERE normalized_plate = %(p)s",
        {"p": normalized},
    )
    if plate_row is None:
        raise HTTPException(status_code=404, detail=f"Unknown plate: {normalized}")
    plate_id = plate_row["plate_id"]

    sightings = await fetch_all(
        _SIGHTINGS_SQL,
        {"plate_id": plate_id, "statuses": statuses, "from_ts": from_ts, "to_ts": to_ts},
    )

    # Points: each sighting as a time-ordered Point feature.
    points = [
        GeoFeature(geometry=dict(row["geometry"]) if row["geometry"] else None,
                   properties={k: v for k, v in row.items() if k != "geometry"})
        for row in sightings
    ]

    # Legs: match consecutive camera pairs to camera_links (one batched query).
    legs: list[TrajectoryLeg] = []
    if len(sightings) >= 2:
        cam_ids = list({row["camera_id"] for row in sightings})
        link_rows = await fetch_all(_LINKS_SQL, {"cam_ids": cam_ids})
        links: dict[tuple[str, str], dict[str, Any]] = {
            (r["from_camera_id"], r["to_camera_id"]): r for r in link_rows
        }

        for prev, curr in zip(sightings, sightings[1:]):
            observed = (curr["spotted_at"] - prev["spotted_at"]).total_seconds()
            link = links.get((prev["camera_id"], curr["camera_id"]))
            if link is not None:
                free_flow = link["free_flow_time_seconds"]
                feasible = observed >= free_flow * FEASIBLE_MIN_RATIO
                legs.append(TrajectoryLeg(
                    from_camera_code=prev["camera_code"],
                    to_camera_code=curr["camera_code"],
                    link_found=True,
                    geometry=dict(link["geometry"]) if link["geometry"] else None,
                    distance_meters=link["distance_meters"],
                    free_flow_seconds=free_flow,
                    observed_seconds=observed,
                    feasible=feasible,
                ))
            else:
                legs.append(TrajectoryLeg(
                    from_camera_code=prev["camera_code"],
                    to_camera_code=curr["camera_code"],
                    link_found=False,
                    observed_seconds=observed,
                    feasible=None,
                ))

    return TrajectoryResponse(
        plate=normalized,
        plate_id=plate_id,
        sighting_count=len(sightings),
        points=GeoFeatureCollection(features=points),
        legs=legs,
    )
