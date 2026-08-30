"""Analytics API: node heatmaps, link congestion, time series, and a summary.

Reads the 5-minute rollup tables (camera_metrics_5m, traffic_metrics_5m) that the
analytics worker populates. Corridor speed is derived on read
(distance_meters / median_travel_time_seconds), never stored. Default window is
the last hour when `from`/`to` are omitted.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from ..db import fetch_all, fetch_one
from ..schemas import (
    AnalyticsSummary,
    CameraMetricWindow,
    GeoFeature,
    GeoFeatureCollection,
    LinkMetricWindow,
)

router = APIRouter(prefix="/analytics", tags=["analytics"])

# COALESCE(param, default) gives a last-hour window when from/to are omitted.
_WFROM = "COALESCE(%(from_ts)s::timestamptz, now() - interval '1 hour')"
_WTO = "COALESCE(%(to_ts)s::timestamptz, now())"


def _fc(rows: list[dict[str, Any]]) -> GeoFeatureCollection:
    return GeoFeatureCollection(features=[
        GeoFeature(geometry=r.pop("geometry", None), properties=r) for r in rows
    ])


@router.get("/camera-heatmap", response_model=GeoFeatureCollection)
async def camera_heatmap(
    from_ts: datetime | None = Query(None, alias="from"),
    to_ts: datetime | None = Query(None, alias="to"),
) -> GeoFeatureCollection:
    """Per-camera totals over the window as GeoJSON points (heatmap intensity)."""
    sql = f"""
        SELECT c.camera_id::text AS camera_id, c.camera_code, c.display_name,
               COALESCE(SUM(m.vehicle_count), 0)::int      AS vehicle_count,
               COALESCE(SUM(m.unique_plate_count), 0)::int AS unique_plate_count,
               COUNT(m.window_start)::int                  AS window_count,
               ST_AsGeoJSON(c.location)::json              AS geometry
        FROM cameras c
        LEFT JOIN camera_metrics_5m m
               ON m.camera_id = c.camera_id
              AND m.window_start >= {_WFROM} AND m.window_start < {_WTO}
        GROUP BY c.camera_id, c.camera_code, c.display_name, c.location
        ORDER BY c.camera_code
    """
    return _fc(await fetch_all(sql, {"from_ts": from_ts, "to_ts": to_ts}))


@router.get("/link-congestion", response_model=GeoFeatureCollection)
async def link_congestion(
    from_ts: datetime | None = Query(None, alias="from"),
    to_ts: datetime | None = Query(None, alias="to"),
) -> GeoFeatureCollection:
    """Per-link congestion over the window as GeoJSON lines, with derived speed."""
    sql = f"""
        SELECT cl.camera_link_id::text AS camera_link_id,
               fc.camera_code AS from_camera_code,
               tc.camera_code AS to_camera_code,
               cl.direction_label, cl.distance_meters,
               ROUND(AVG(tm.congestion_score), 3)::float8        AS avg_congestion_score,
               ROUND(AVG(tm.median_travel_time_seconds))::int    AS avg_median_travel_time_seconds,
               CASE WHEN AVG(tm.median_travel_time_seconds) > 0
                    THEN ROUND((cl.distance_meters / AVG(tm.median_travel_time_seconds) * 3.6)::numeric, 1)::float8
                    ELSE NULL END                                AS est_speed_kph,
               COALESCE(SUM(tm.vehicle_count), 0)::int           AS vehicle_count,
               COUNT(tm.window_start)::int                       AS window_count,
               ST_AsGeoJSON(cl.path)::json                       AS geometry
        FROM camera_links cl
        JOIN cameras fc ON fc.camera_id = cl.from_camera_id
        JOIN cameras tc ON tc.camera_id = cl.to_camera_id
        LEFT JOIN traffic_metrics_5m tm
               ON tm.camera_link_id = cl.camera_link_id
              AND tm.window_start >= {_WFROM} AND tm.window_start < {_WTO}
        GROUP BY cl.camera_link_id, fc.camera_code, tc.camera_code,
                 cl.direction_label, cl.distance_meters, cl.path
        ORDER BY avg_congestion_score DESC NULLS LAST
    """
    return _fc(await fetch_all(sql, {"from_ts": from_ts, "to_ts": to_ts}))


@router.get("/camera-metrics", response_model=list[CameraMetricWindow])
async def camera_metrics(
    camera_code: str = Query(..., description="camera to fetch the time series for"),
    from_ts: datetime | None = Query(None, alias="from"),
    to_ts: datetime | None = Query(None, alias="to"),
) -> list[CameraMetricWindow]:
    """5-minute time series for one camera node."""
    cam = await fetch_one(
        "SELECT camera_id FROM cameras WHERE camera_code = %(c)s", {"c": camera_code}
    )
    if cam is None:
        raise HTTPException(status_code=404, detail=f"Unknown camera: {camera_code}")
    sql = f"""
        SELECT m.window_start, m.vehicle_count, m.unique_plate_count, m.significant_change
        FROM camera_metrics_5m m
        JOIN cameras c ON c.camera_id = m.camera_id
        WHERE c.camera_code = %(code)s
          AND m.window_start >= {_WFROM} AND m.window_start < {_WTO}
        ORDER BY m.window_start
    """
    rows = await fetch_all(sql, {"code": camera_code, "from_ts": from_ts, "to_ts": to_ts})
    return [CameraMetricWindow(**r) for r in rows]


@router.get("/link-metrics", response_model=list[LinkMetricWindow])
async def link_metrics(
    camera_link_id: str = Query(..., description="link to fetch the time series for"),
    from_ts: datetime | None = Query(None, alias="from"),
    to_ts: datetime | None = Query(None, alias="to"),
) -> list[LinkMetricWindow]:
    """5-minute time series for one link, with per-window derived speed."""
    link = await fetch_one(
        "SELECT distance_meters FROM camera_links WHERE camera_link_id = %(id)s",
        {"id": camera_link_id},
    )
    if link is None:
        raise HTTPException(status_code=404, detail="Unknown camera_link_id")
    sql = f"""
        SELECT tm.window_start, tm.vehicle_count, tm.unique_vehicle_count,
               tm.median_travel_time_seconds, tm.baseline_travel_time_seconds,
               tm.congestion_score::float8 AS congestion_score,
               CASE WHEN tm.median_travel_time_seconds > 0
                    THEN ROUND((cl.distance_meters / tm.median_travel_time_seconds::numeric * 3.6), 1)::float8
                    ELSE NULL END AS est_speed_kph,
               tm.travel_time_sample_count, tm.significant_change
        FROM traffic_metrics_5m tm
        JOIN camera_links cl ON cl.camera_link_id = tm.camera_link_id
        WHERE tm.camera_link_id = %(id)s
          AND tm.window_start >= {_WFROM} AND tm.window_start < {_WTO}
        ORDER BY tm.window_start
    """
    rows = await fetch_all(sql, {"id": camera_link_id, "from_ts": from_ts, "to_ts": to_ts})
    return [LinkMetricWindow(**r) for r in rows]


@router.get("/summary", response_model=AnalyticsSummary)
async def summary(
    from_ts: datetime | None = Query(None, alias="from"),
    to_ts: datetime | None = Query(None, alias="to"),
) -> AnalyticsSummary:
    """Headline numbers for the dashboard cards over the window."""
    sql = f"""
        WITH win AS (SELECT {_WFROM} AS f, {_WTO} AS t)
        SELECT
          (SELECT f FROM win) AS from_ts,
          (SELECT t FROM win) AS to_ts,
          (SELECT COALESCE(SUM(vehicle_count), 0)::int
             FROM camera_metrics_5m m, win
            WHERE m.window_start >= win.f AND m.window_start < win.t) AS total_vehicle_passes,
          (SELECT COALESCE(SUM(unique_plate_count), 0)::int
             FROM camera_metrics_5m m, win
            WHERE m.window_start >= win.f AND m.window_start < win.t) AS total_unique_plates,
          (SELECT jsonb_build_object('camera_code', c.camera_code, 'vehicle_count', s.v)
             FROM (SELECT camera_id, SUM(vehicle_count) AS v
                     FROM camera_metrics_5m m, win
                    WHERE m.window_start >= win.f AND m.window_start < win.t
                    GROUP BY camera_id ORDER BY v DESC LIMIT 1) s
             JOIN cameras c ON c.camera_id = s.camera_id) AS busiest_camera,
          (SELECT jsonb_build_object('from_camera_code', fc.camera_code,
                                     'to_camera_code', tc.camera_code,
                                     'avg_congestion_score', ROUND(s.sc, 3))
             FROM (SELECT camera_link_id, AVG(congestion_score) AS sc
                     FROM traffic_metrics_5m m, win
                    WHERE m.window_start >= win.f AND m.window_start < win.t
                    GROUP BY camera_link_id ORDER BY sc DESC LIMIT 1) s
             JOIN camera_links cl ON cl.camera_link_id = s.camera_link_id
             JOIN cameras fc ON fc.camera_id = cl.from_camera_id
             JOIN cameras tc ON tc.camera_id = cl.to_camera_id) AS most_congested_link
    """
    row = await fetch_one(sql, {"from_ts": from_ts, "to_ts": to_ts})
    return AnalyticsSummary(**row)  # type: ignore[arg-type]
