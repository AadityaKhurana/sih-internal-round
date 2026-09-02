"""GET /analytics/reports/periods and /analytics/reports — weekly/monthly rollups."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from ..db import fetch_all, fetch_one
from ._common import iso
from .analytics import aggregate_links

router = APIRouter(prefix="/analytics", tags=["reports"])


async def _periods(granularity: str) -> list[dict[str, Any]]:
    if granularity == "week":
        sql = """
            SELECT date_trunc('week', window_start) AS f,
                   date_trunc('week', window_start) + interval '7 days' AS t,
                   to_char(date_trunc('week', window_start), 'IYYY"-W"IW') AS period,
                   to_char(date_trunc('week', window_start), 'IYYY"-W"IW') AS label
            FROM camera_metrics_5m GROUP BY 1 ORDER BY f DESC
        """
    elif granularity == "month":
        sql = """
            SELECT date_trunc('month', window_start) AS f,
                   date_trunc('month', window_start) + interval '1 month' AS t,
                   to_char(date_trunc('month', window_start), 'YYYY-MM') AS period,
                   to_char(date_trunc('month', window_start), 'FMMonth YYYY') AS label
            FROM camera_metrics_5m GROUP BY 1 ORDER BY f DESC
        """
    else:
        raise HTTPException(status_code=422, detail="granularity must be week or month")
    return await fetch_all(sql)


@router.get("/reports/periods")
async def report_periods(granularity: str = Query("week")) -> dict[str, Any]:
    rows = await _periods(granularity)
    return {"periods": [{"granularity": granularity, "label": r["label"], "period": r["period"]}
                        for r in rows]}


async def _scalar(sql: str, params: dict, key: str) -> Any:
    row = await fetch_one(sql, params)
    return row[key] if row else None


@router.get("/reports")
async def report(
    granularity: str = Query("week"),
    period: str | None = Query(None),
) -> dict[str, Any]:
    periods = await _periods(granularity)
    if not periods:
        raise HTTPException(status_code=404, detail="No data for any period")
    chosen = periods[0] if period is None else next((p for p in periods if p["period"] == period), None)
    if chosen is None:
        raise HTTPException(status_code=422, detail=f"Unknown period: {period}")
    frm, to = chosen["f"], chosen["t"]
    span = to - frm
    prev_from = frm - span
    P = {"from_ts": frm, "to_ts": to}

    total_sightings = await _scalar(
        "SELECT count(*) AS n FROM sightings WHERE spotted_at >= %(from_ts)s AND spotted_at < %(to_ts)s", P, "n")
    unique_plates = await _scalar(
        "SELECT count(DISTINCT plate_id) AS n FROM sightings WHERE spotted_at >= %(from_ts)s AND spotted_at < %(to_ts)s AND plate_id IS NOT NULL", P, "n")
    cong = await fetch_one(
        "SELECT AVG(congestion_score)::float8 AS a, MAX(congestion_score)::float8 AS p FROM traffic_metrics_5m WHERE window_start >= %(from_ts)s AND window_start < %(to_ts)s", P)
    busiest = await _scalar("""
        SELECT c.camera_code AS n FROM camera_metrics_5m m JOIN cameras c ON c.camera_id=m.camera_id
        WHERE m.window_start >= %(from_ts)s AND m.window_start < %(to_ts)s
        GROUP BY c.camera_code ORDER BY SUM(m.vehicle_count) DESC LIMIT 1""", P, "n")
    alert_count = await _scalar(
        "SELECT count(*) AS n FROM alerts WHERE created_at >= %(from_ts)s AND created_at < %(to_ts)s", P, "n")
    delay = await _scalar("""
        SELECT SUM(GREATEST(COALESCE(median_travel_time_seconds,0) - COALESCE(baseline_travel_time_seconds,0), 0))
               / 3600.0 AS n
        FROM traffic_metrics_5m WHERE window_start >= %(from_ts)s AND window_start < %(to_ts)s""", P, "n")

    links = sorted(await aggregate_links(frm, to),
                   key=lambda l: (l["congestion_score"] or 0), reverse=True)
    worst_links = links[:5]
    worst_link_label = (f'{worst_links[0]["from_camera_code"]}\u2192{worst_links[0]["to_camera_code"]}'
                        if worst_links and worst_links[0]["congestion_score"] else None)

    summary = {
        "total_sightings": total_sightings or 0,
        "unique_plates": unique_plates or 0,
        "avg_congestion_score": round(cong["a"], 3) if cong and cong["a"] is not None else None,
        "peak_congestion_score": round(cong["p"], 3) if cong and cong["p"] is not None else None,
        "busiest_camera_code": busiest,
        "worst_link_label": worst_link_label,
        "alert_count": alert_count or 0,
        "total_delay_hours": round(delay, 2) if delay is not None else None,
    }

    # Comparison vs previous period.
    prevP = {"from_ts": prev_from, "to_ts": frm}
    prev_vol = await _scalar(
        "SELECT COALESCE(SUM(vehicle_count),0) AS n FROM camera_metrics_5m WHERE window_start >= %(from_ts)s AND window_start < %(to_ts)s", prevP, "n")
    prev_cong = await _scalar(
        "SELECT AVG(congestion_score)::float8 AS n FROM traffic_metrics_5m WHERE window_start >= %(from_ts)s AND window_start < %(to_ts)s", prevP, "n")
    cur_vol = await _scalar(
        "SELECT COALESCE(SUM(vehicle_count),0) AS n FROM camera_metrics_5m WHERE window_start >= %(from_ts)s AND window_start < %(to_ts)s", P, "n")
    comparison = None
    if prev_vol:
        comparison = {
            "previous_label": f"{iso(prev_from)}",
            "volume_delta_pct": round((cur_vol - prev_vol) / prev_vol * 100, 1) if prev_vol else None,
            "congestion_delta_pct": (round((summary["avg_congestion_score"] - prev_cong) / prev_cong * 100, 1)
                                     if prev_cong and summary["avg_congestion_score"] is not None else None),
        }

    # Hourly profile: full 7x24 grid (0=Mon..6=Sun).
    veh = {(r["dow"], r["hr"]): r["v"] for r in await fetch_all("""
        SELECT (EXTRACT(ISODOW FROM window_start)::int - 1) AS dow,
               EXTRACT(HOUR FROM window_start)::int AS hr, SUM(vehicle_count)::int AS v
        FROM camera_metrics_5m WHERE window_start >= %(from_ts)s AND window_start < %(to_ts)s
        GROUP BY dow, hr""", P)}
    con = {(r["dow"], r["hr"]): r["c"] for r in await fetch_all("""
        SELECT (EXTRACT(ISODOW FROM window_start)::int - 1) AS dow,
               EXTRACT(HOUR FROM window_start)::int AS hr, AVG(congestion_score)::float8 AS c
        FROM traffic_metrics_5m WHERE window_start >= %(from_ts)s AND window_start < %(to_ts)s
        GROUP BY dow, hr""", P)}
    hourly_profile = [{
        "day_of_week": d, "hour": h,
        "congestion_score": round(con[(d, h)], 3) if (d, h) in con and con[(d, h)] is not None else None,
        "vehicle_count": veh.get((d, h), 0),
    } for d in range(7) for h in range(24)]

    daily_veh = {r["d"].isoformat(): r for r in await fetch_all("""
        SELECT window_start::date AS d, SUM(vehicle_count)::int AS v
        FROM camera_metrics_5m WHERE window_start >= %(from_ts)s AND window_start < %(to_ts)s
        GROUP BY d ORDER BY d""", P)}
    daily_con = {r["d"].isoformat(): r for r in await fetch_all("""
        SELECT window_start::date AS d, AVG(congestion_score)::float8 AS c,
               SUM(baseline_vehicle_count)::int AS b
        FROM traffic_metrics_5m WHERE window_start >= %(from_ts)s AND window_start < %(to_ts)s
        GROUP BY d""", P)}
    daily_series = [{
        "date": d,
        "vehicle_count": daily_veh[d]["v"],
        "avg_congestion_score": round(daily_con[d]["c"], 3) if d in daily_con and daily_con[d]["c"] is not None else None,
        "baseline_vehicle_count": daily_con[d]["b"] if d in daily_con else None,
    } for d in sorted(daily_veh)]

    alerts_by_type = [{
        "alert_type": r["alert_type"], "anomaly_reason": r["anomaly_reason"], "count": r["n"],
    } for r in await fetch_all("""
        SELECT alert_type, anomaly_reason, count(*)::int AS n FROM alerts
        WHERE created_at >= %(from_ts)s AND created_at < %(to_ts)s
        GROUP BY alert_type, anomaly_reason ORDER BY n DESC""", P)]

    return {
        "period": {"granularity": granularity, "label": chosen["label"],
                   "from": iso(frm), "to": iso(to)},
        "summary": summary,
        "comparison": comparison,
        "worst_links": worst_links,
        "hourly_profile": hourly_profile,
        "daily_series": daily_series,
        "alerts_by_type": alerts_by_type,
    }
