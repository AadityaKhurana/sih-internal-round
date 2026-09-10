"""Analytics: node metrics, link congestion, flow trends, origin-destination.

Windowed over camera_metrics_5m / traffic_metrics_5m. Derived speed and
congestion_score (median / free_flow) are computed on read per the schema note.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from ..db import fetch_all
from ._common import iso

router = APIRouter(prefix="/analytics", tags=["analytics"])

_ALLOWED_BUCKETS = (5, 15, 30, 60)


def _window(from_ts: datetime | None, to_ts: datetime | None) -> tuple[datetime, datetime]:
    to = to_ts or datetime.now(timezone.utc)
    frm = from_ts or (to - timedelta(hours=24))
    return frm, to


# --------------------------------------------------------------------- nodes --
_NODES_SQL = """
    SELECT c.camera_id::text AS camera_id, c.camera_code, c.display_name, c.status,
           ST_X(c.location)::float8 AS lng, ST_Y(c.location)::float8 AS lat,
           COALESCE(SUM(m.vehicle_count), 0)::int      AS vehicle_count,
           COALESCE(SUM(m.unique_plate_count), 0)::int AS unique_plate_count,
           COALESCE(MAX(m.vehicle_count), 0)::int      AS peak_5m_vehicle_count,
           COALESCE(bool_or(m.significant_change), false) AS significant_change
    FROM cameras c
    LEFT JOIN camera_metrics_5m m
           ON m.camera_id = c.camera_id
          AND m.window_start >= %(from_ts)s AND m.window_start < %(to_ts)s
    GROUP BY c.camera_id, c.camera_code, c.display_name, c.status, c.location
    ORDER BY c.camera_code
"""


@router.get("/nodes")
async def node_metrics(
    from_ts: datetime | None = Query(None, alias="from"),
    to_ts: datetime | None = Query(None, alias="to"),
) -> dict[str, Any]:
    frm, to = _window(from_ts, to_ts)
    rows = await fetch_all(_NODES_SQL, {"from_ts": frm, "to_ts": to})
    nodes = [{
        "camera_id": r["camera_id"], "camera_code": r["camera_code"],
        "display_name": r["display_name"], "status": r["status"],
        "location": [r["lng"], r["lat"]],
        "vehicle_count": r["vehicle_count"], "unique_plate_count": r["unique_plate_count"],
        "peak_5m_vehicle_count": r["peak_5m_vehicle_count"],
        "significant_change": r["significant_change"], "vs_baseline_pct": None,
    } for r in rows]
    return {
        "window": {"from": iso(frm), "to": iso(to)},
        "nodes": nodes,
        "max_vehicle_count": max((n["vehicle_count"] for n in nodes), default=0),
    }


# --------------------------------------------------------------------- links --
_LINKS_SQL = """
    SELECT cl.camera_link_id::text AS camera_link_id,
           cl.from_camera_id::text AS from_camera_id, cl.to_camera_id::text AS to_camera_id,
           fc.camera_code AS from_camera_code, tc.camera_code AS to_camera_code,
           r.name AS road_name, cl.direction_label,
           cl.distance_meters, cl.free_flow_time_seconds, cl.speed_limit_kph,
           COALESCE(SUM(tm.vehicle_count), 0)::int        AS vehicle_count,
           COALESCE(SUM(tm.unique_vehicle_count), 0)::int AS unique_vehicle_count,
           AVG(tm.median_travel_time_seconds)             AS avg_median,
           AVG(tm.baseline_travel_time_seconds)           AS avg_baseline,
           AVG(tm.baseline_vehicle_count)                 AS avg_baseline_vehicles,
           COALESCE(SUM(tm.travel_time_sample_count), 0)::int AS travel_time_sample_count,
           COALESCE(bool_or(tm.significant_change), false) AS significant_change,
           ST_AsGeoJSON(cl.path)::json AS path
    FROM camera_links cl
    JOIN cameras fc ON fc.camera_id = cl.from_camera_id
    JOIN cameras tc ON tc.camera_id = cl.to_camera_id
    LEFT JOIN roads r ON r.road_id = cl.road_id
    LEFT JOIN traffic_metrics_5m tm
           ON tm.camera_link_id = cl.camera_link_id
          AND tm.window_start >= %(from_ts)s AND tm.window_start < %(to_ts)s
    GROUP BY cl.camera_link_id, cl.from_camera_id, cl.to_camera_id, fc.camera_code,
             tc.camera_code, r.name, cl.direction_label, cl.distance_meters,
             cl.free_flow_time_seconds, cl.speed_limit_kph, cl.path
    ORDER BY cl.camera_link_id
"""


def _link_row(r: dict[str, Any]) -> dict[str, Any]:
    median = round(r["avg_median"]) if r["avg_median"] is not None else None
    baseline = round(r["avg_baseline"]) if r["avg_baseline"] is not None else None
    ff = r["free_flow_time_seconds"]
    score = round(median / ff, 3) if median and ff else None
    speed = round(r["distance_meters"] / median * 3.6, 1) if median else None
    return {
        "camera_link_id": r["camera_link_id"],
        "from_camera_id": r["from_camera_id"], "to_camera_id": r["to_camera_id"],
        "from_camera_code": r["from_camera_code"], "to_camera_code": r["to_camera_code"],
        "road_name": r["road_name"], "direction_label": r["direction_label"],
        "distance_meters": r["distance_meters"], "free_flow_time_seconds": ff,
        "speed_limit_kph": r["speed_limit_kph"],
        "vehicle_count": r["vehicle_count"], "unique_vehicle_count": r["unique_vehicle_count"],
        "median_travel_time_seconds": median,
        "baseline_travel_time_seconds": baseline,
        "baseline_vehicle_count": round(r["avg_baseline_vehicles"]) if r["avg_baseline_vehicles"] is not None else None,
        "congestion_score": score,
        "travel_time_sample_count": r["travel_time_sample_count"],
        "significant_change": r["significant_change"],
        "derived_speed_kph": speed,
        "path": r["path"],
    }


async def aggregate_links(frm: datetime, to: datetime) -> list[dict[str, Any]]:
    return [_link_row(r) for r in await fetch_all(_LINKS_SQL, {"from_ts": frm, "to_ts": to})]


@router.get("/links")
async def link_congestion(
    from_ts: datetime | None = Query(None, alias="from"),
    to_ts: datetime | None = Query(None, alias="to"),
) -> dict[str, Any]:
    frm, to = _window(from_ts, to_ts)
    links = await aggregate_links(frm, to)
    scores = [l["congestion_score"] for l in links if l["congestion_score"] is not None]
    return {
        "window": {"from": iso(frm), "to": iso(to)},
        "links": links,
        "network_avg_congestion_score": round(sum(scores) / len(scores), 3) if scores else None,
    }


# ---------------------------------------------------------------- flow trends --
@router.get("/flow-trends")
async def flow_trends(
    from_ts: datetime | None = Query(None, alias="from"),
    to_ts: datetime | None = Query(None, alias="to"),
    scope: str = Query("network"),
    target_id: str | None = Query(None),
    bucket_minutes: int = Query(15),
) -> dict[str, Any]:
    frm, to = _window(from_ts, to_ts)
    if bucket_minutes not in _ALLOWED_BUCKETS:
        raise HTTPException(status_code=422, detail=f"bucket_minutes must be one of {_ALLOWED_BUCKETS}")
    label = "Network"
    params = {"from_ts": frm, "to_ts": to, "bucket": bucket_minutes, "target": target_id}

    if scope == "camera":
        if not target_id:
            raise HTTPException(status_code=422, detail="target_id (camera_code) required for scope=camera")
        cam = await fetch_all("SELECT display_name FROM cameras WHERE camera_code = %(t)s", {"t": target_id})
        if not cam:
            raise HTTPException(status_code=404, detail="Unknown camera")
        label = cam[0]["display_name"]
        rows = await fetch_all(f"""
            SELECT date_bin(make_interval(mins => %(bucket)s), m.window_start, timestamptz 'epoch') AS bucket,
                   SUM(m.vehicle_count)::int AS vehicle_count,
                   SUM(m.unique_plate_count)::int AS unique_vehicle_count
            FROM camera_metrics_5m m JOIN cameras c ON c.camera_id = m.camera_id
            WHERE c.camera_code = %(target)s
              AND m.window_start >= %(from_ts)s AND m.window_start < %(to_ts)s
            GROUP BY bucket ORDER BY bucket
        """, params)
        points = [{"window_start": iso(r["bucket"]), "vehicle_count": r["vehicle_count"],
                   "unique_vehicle_count": r["unique_vehicle_count"],
                   "median_travel_time_seconds": None, "congestion_score": None,
                   "baseline_vehicle_count": None} for r in rows]
    else:
        link_filter = ""
        if scope == "link":
            if not target_id:
                raise HTTPException(status_code=422, detail="target_id (camera_link_id) required for scope=link")
            link_filter = "AND tm.camera_link_id = %(target)s"
            lk = await fetch_all("""
                SELECT fc.camera_code AS f, tc.camera_code AS t FROM camera_links cl
                JOIN cameras fc ON fc.camera_id=cl.from_camera_id
                JOIN cameras tc ON tc.camera_id=cl.to_camera_id
                WHERE cl.camera_link_id = %(t)s""", {"t": target_id})
            if not lk:
                raise HTTPException(status_code=404, detail="Unknown camera_link_id")
            label = f"{lk[0]['f']}\u2192{lk[0]['t']}"
        rows = await fetch_all(f"""
            SELECT date_bin(make_interval(mins => %(bucket)s), tm.window_start, timestamptz 'epoch') AS bucket,
                   SUM(tm.vehicle_count)::int AS vehicle_count,
                   SUM(tm.unique_vehicle_count)::int AS unique_vehicle_count,
                   AVG(tm.median_travel_time_seconds) AS median_tt,
                   AVG(tm.congestion_score)::float8 AS congestion_score,
                   SUM(tm.baseline_vehicle_count)::int AS baseline_vehicle_count
            FROM traffic_metrics_5m tm
            WHERE tm.window_start >= %(from_ts)s AND tm.window_start < %(to_ts)s {link_filter}
            GROUP BY bucket ORDER BY bucket
        """, params)
        points = [{"window_start": iso(r["bucket"]), "vehicle_count": r["vehicle_count"],
                   "unique_vehicle_count": r["unique_vehicle_count"],
                   "median_travel_time_seconds": round(r["median_tt"]) if r["median_tt"] is not None else None,
                   "congestion_score": round(r["congestion_score"], 3) if r["congestion_score"] is not None else None,
                   "baseline_vehicle_count": r["baseline_vehicle_count"]} for r in rows]

    return {"window": {"from": iso(frm), "to": iso(to)}, "scope": scope,
            "target_id": target_id, "target_label": label,
            "bucket_minutes": bucket_minutes, "points": points}


# ---------------------------------------------------------- origin-destination --
_OD_SQL = """
    WITH ordered AS (
        SELECT s.plate_id, s.camera_id, s.spotted_at,
               LAG(s.camera_id)  OVER w AS prev_cam,
               LAG(s.spotted_at) OVER w AS prev_time
        FROM sightings s
        WHERE s.validation_status = 'accepted'
          AND s.spotted_at >= %(from_ts)s AND s.spotted_at < %(to_ts)s
        WINDOW w AS (PARTITION BY s.plate_id ORDER BY s.spotted_at)
    ),
    journeys AS (
        SELECT prev_cam AS from_id, camera_id AS to_id,
               EXTRACT(EPOCH FROM (spotted_at - prev_time)) AS tt
        FROM ordered
        WHERE prev_cam IS NOT NULL AND prev_cam <> camera_id
          AND spotted_at - prev_time <= interval '1 hour'
    )
    SELECT j.from_id::text AS from_id, j.to_id::text AS to_id,
           fc.camera_code AS from_camera_code, tc.camera_code AS to_camera_code,
           count(*)::int AS journey_count,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY j.tt) AS median_tt
    FROM journeys j
    JOIN cameras fc ON fc.camera_id = j.from_id
    JOIN cameras tc ON tc.camera_id = j.to_id
    GROUP BY j.from_id, j.to_id, fc.camera_code, tc.camera_code
    ORDER BY journey_count DESC
"""


@router.get("/origin-destination")
async def origin_destination(
    from_ts: datetime | None = Query(None, alias="from"),
    to_ts: datetime | None = Query(None, alias="to"),
) -> dict[str, Any]:
    frm, to = _window(from_ts, to_ts)
    rows = await fetch_all(_OD_SQL, {"from_ts": frm, "to_ts": to})
    origin_totals: dict[str, int] = {}
    for r in rows:
        origin_totals[r["from_id"]] = origin_totals.get(r["from_id"], 0) + r["journey_count"]
    total = sum(r["journey_count"] for r in rows)
    pairs = [{
        "from_camera_id": r["from_id"], "to_camera_id": r["to_id"],
        "from_camera_code": r["from_camera_code"], "to_camera_code": r["to_camera_code"],
        "journey_count": r["journey_count"],
        "median_travel_time_seconds": round(r["median_tt"]) if r["median_tt"] is not None else None,
        "share_pct": round(r["journey_count"] / origin_totals[r["from_id"]] * 100, 1)
                     if origin_totals[r["from_id"]] else 0.0,
    } for r in rows]
    codes = sorted({c for r in rows for c in (r["from_camera_code"], r["to_camera_code"])})
    return {"window": {"from": iso(frm), "to": iso(to)}, "camera_codes": codes,
            "pairs": pairs, "total_journeys": total}
