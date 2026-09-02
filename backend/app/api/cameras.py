"""Network read endpoints: cameras and camera_links as GeoJSON for the map,
with the denormalized properties the dashboard needs (road names, endpoint codes)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from ..db import fetch_all
from ._common import iso

router = APIRouter(tags=["geo"])

_CAMERAS_SQL = """
    SELECT c.camera_id::text        AS camera_id,
           c.camera_code,
           c.display_name,
           c.heading_degrees::float8 AS heading_degrees,
           c.status,
           c.last_seen_at,
           ST_AsGeoJSON(c.location)::json AS geometry,
           (SELECT array_agg(DISTINCT r.name)
              FROM camera_links cl
              JOIN roads r ON r.road_id = cl.road_id
             WHERE (cl.from_camera_id = c.camera_id OR cl.to_camera_id = c.camera_id)
               AND r.name IS NOT NULL) AS road_names
    FROM cameras c
    ORDER BY c.camera_code
"""

_LINKS_SQL = """
    SELECT cl.camera_link_id::text AS camera_link_id,
           cl.from_camera_id::text AS from_camera_id,
           cl.to_camera_id::text   AS to_camera_id,
           fc.camera_code          AS from_camera_code,
           tc.camera_code          AS to_camera_code,
           cl.road_id::text        AS road_id,
           r.name                  AS road_name,
           cl.direction_label,
           cl.distance_meters,
           cl.free_flow_time_seconds,
           cl.speed_limit_kph,
           cl.active,
           ST_AsGeoJSON(cl.path)::json AS geometry
    FROM camera_links cl
    JOIN cameras fc ON fc.camera_id = cl.from_camera_id
    JOIN cameras tc ON tc.camera_id = cl.to_camera_id
    LEFT JOIN roads r ON r.road_id = cl.road_id
    ORDER BY cl.camera_link_id
"""


def _fc(rows: list[dict[str, Any]]) -> dict[str, Any]:
    features = []
    for r in rows:
        geom = r.pop("geometry", None)
        if "last_seen_at" in r:
            r["last_seen_at"] = iso(r["last_seen_at"])
        if r.get("road_names") is None and "road_names" in r:
            r["road_names"] = []
        features.append({"type": "Feature", "geometry": geom, "properties": r})
    return {"type": "FeatureCollection", "features": features}


@router.get("/cameras")
async def list_cameras() -> dict[str, Any]:
    return _fc(await fetch_all(_CAMERAS_SQL))


@router.get("/camera-links")
async def list_camera_links() -> dict[str, Any]:
    return _fc(await fetch_all(_LINKS_SQL))
