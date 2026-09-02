"""Geographic read endpoints: cameras and camera_links as GeoJSON for the map."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from ..db import fetch_all
from ..schemas import GeoFeature, GeoFeatureCollection

router = APIRouter(tags=["geo"])

_CAMERAS_SQL = """
    SELECT camera_id::text            AS camera_id,
           camera_code,
           display_name,
           heading_degrees::float8    AS heading_degrees,
           status,
           stream_uri_ref,
           last_seen_at,
           ST_AsGeoJSON(location)::json AS geometry
    FROM cameras
    ORDER BY camera_code
"""

_LINKS_SQL = """
    SELECT camera_link_id::text   AS camera_link_id,
           from_camera_id::text   AS from_camera_id,
           to_camera_id::text     AS to_camera_id,
           road_id::text          AS road_id,
           direction_label,
           distance_meters,
           free_flow_time_seconds,
           speed_limit_kph,
           active,
           ST_AsGeoJSON(path)::json AS geometry
    FROM camera_links
    ORDER BY camera_link_id
"""


def _to_feature_collection(rows: list[dict[str, Any]]) -> GeoFeatureCollection:
    features = [
        GeoFeature(geometry=row.pop("geometry", None), properties=row) for row in rows
    ]
    return GeoFeatureCollection(features=features)


@router.get("/cameras", response_model=GeoFeatureCollection)
async def list_cameras() -> GeoFeatureCollection:
    """All cameras as a GeoJSON FeatureCollection (Point geometry)."""
    return _to_feature_collection(await fetch_all(_CAMERAS_SQL))


@router.get("/camera-links", response_model=GeoFeatureCollection)
async def list_camera_links() -> GeoFeatureCollection:
    """All monitored camera-to-camera links as GeoJSON (LineString geometry)."""
    return _to_feature_collection(await fetch_all(_LINKS_SQL))
