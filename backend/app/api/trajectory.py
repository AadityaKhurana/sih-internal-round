"""GET /plates/{plate}/trajectory — full reconstruction.

Accepted sightings form the route; non-accepted are returned separately. The
timeline is split into trips (segments) so parked gaps are never counted as
travel, and each within-segment hop is validated against camera_links to a
hop_status. Routes are reconstructed here, never stored.
"""
from __future__ import annotations

import math
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Query

from ..db import fetch_all, fetch_one
from ._common import SIGHTING_SELECT, iso, normalize_plate, sighting_row_to_dict

router = APIRouter(tags=["trajectory"])

SAME_PASS_SECONDS = 300          # two sightings at one camera within 5 min = one pass
UNMONITORED_TRIP_GAP = 1800      # 30 min gap between unmonitored cameras => new trip
MIN_FEASIBLE_RATIO = 0.5         # faster than 50% of free-flow time => impossible

_LINKS_SQL = """
    SELECT cl.camera_link_id::text AS camera_link_id,
           cl.from_camera_id::text AS from_camera_id,
           cl.to_camera_id::text   AS to_camera_id,
           cl.distance_meters, cl.free_flow_time_seconds, cl.direction_label,
           r.name AS road_name,
           ST_AsGeoJSON(cl.path)::json AS path
    FROM camera_links cl
    LEFT JOIN roads r ON r.road_id = cl.road_id
    WHERE cl.from_camera_id::text = ANY(%(ids)s) AND cl.to_camera_id::text = ANY(%(ids)s)
"""


def _bearing(lng1: float, lat1: float, lng2: float, lat2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lng2 - lng1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def _angle_diff(a: float, b: float) -> float:
    return abs((a - b + 180) % 360 - 180)


def _hop(prev: dict, curr: dict, gap: float, link: dict | None) -> dict[str, Any]:
    base = {
        "from_sighting_id": prev["sighting_id"], "to_sighting_id": curr["sighting_id"],
        "from_camera_id": prev["camera_id"], "to_camera_id": curr["camera_id"],
        "from_camera_code": prev["camera_code"], "to_camera_code": curr["camera_code"],
        "departed_at": iso(prev["spotted_at"]), "arrived_at": iso(curr["spotted_at"]),
        "travel_time_seconds": int(gap),
    }
    if link is None:
        base.update(camera_link_id=None, road_name=None, direction_label=None,
                    distance_meters=None, free_flow_time_seconds=None,
                    implied_speed_kph=None, hop_status="no_link", path=None)
        return base
    dist = link["distance_meters"]
    ff = link["free_flow_time_seconds"]
    implied = round(dist / gap * 3.6, 1) if gap > 0 else None
    status = "valid"
    if gap < ff * MIN_FEASIBLE_RATIO:
        status = "impossible_travel_time"
    elif curr["direction_degrees"] is not None:
        bearing = _bearing(prev["s_lng"], prev["s_lat"], curr["s_lng"], curr["s_lat"])
        if _angle_diff(bearing, curr["direction_degrees"]) > 90:
            status = "wrong_direction"
    base.update(
        camera_link_id=link["camera_link_id"], road_name=link["road_name"],
        direction_label=link["direction_label"], distance_meters=dist,
        free_flow_time_seconds=ff, implied_speed_kph=implied, hop_status=status,
        path=link["path"],
    )
    return base


@router.get("/plates/{plate}/trajectory")
async def plate_trajectory(
    plate: str,
    from_ts: datetime | None = Query(None, alias="from"),
    to_ts: datetime | None = Query(None, alias="to"),
    include_unvalidated: bool = Query(True),
) -> dict[str, Any]:
    norm = normalize_plate(plate) or ""
    prow = await fetch_one(
        "SELECT plate_id::text AS plate_id, normalized_plate FROM plates WHERE normalized_plate = %(p)s",
        {"p": norm},
    )
    window = {"from": iso(from_ts), "to": iso(to_ts)}
    empty = {
        "plate": {"plate_id": None, "normalized_plate": norm}, "window": window,
        "sightings": [], "excluded_sightings": [], "hops": [], "segments": [],
        "summary": {"sighting_count": 0, "accepted_count": 0, "excluded_count": 0,
                    "distinct_camera_count": 0, "first_seen_at": None, "last_seen_at": None,
                    "total_distance_meters": 0, "total_duration_seconds": 0,
                    "average_speed_kph": None, "anomaly_hop_count": 0,
                    "unmonitored_hop_count": 0, "segment_count": 0},
    }
    if prow is None:
        return empty
    plate_id = prow["plate_id"]

    rows = await fetch_all(
        f"""{SIGHTING_SELECT}
            WHERE s.plate_id = %(pid)s
              AND (%(from_ts)s::timestamptz IS NULL OR s.spotted_at >= %(from_ts)s)
              AND (%(to_ts)s::timestamptz   IS NULL OR s.spotted_at <= %(to_ts)s)
            ORDER BY s.spotted_at ASC""",
        {"pid": plate_id, "from_ts": from_ts, "to_ts": to_ts},
    )
    accepted = [r for r in rows if r["validation_status"] == "accepted"]
    excluded = [r for r in rows if r["validation_status"] != "accepted"]

    # Links among the cameras that appear on the route (one query).
    links: dict[tuple[str, str], dict] = {}
    if len(accepted) >= 2:
        cam_ids = list({r["camera_id"] for r in accepted})
        for lk in await fetch_all(_LINKS_SQL, {"ids": cam_ids}):
            links[(lk["from_camera_id"], lk["to_camera_id"])] = lk

    hops: list[dict] = []
    segs: list[list[dict]] = [[accepted[0]]] if accepted else []
    seg_hops: list[list[dict]] = [[]] if accepted else []

    for prev, curr in zip(accepted, accepted[1:]):
        gap = (curr["spotted_at"] - prev["spotted_at"]).total_seconds()
        if prev["camera_id"] == curr["camera_id"]:
            if gap > UNMONITORED_TRIP_GAP:
                segs.append([curr]); seg_hops.append([])
            else:
                segs[-1].append(curr)  # same pass / dwell
            continue
        link = links.get((prev["camera_id"], curr["camera_id"]))
        threshold = max(900, 6 * link["free_flow_time_seconds"]) if link else UNMONITORED_TRIP_GAP
        if gap > threshold:
            segs.append([curr]); seg_hops.append([])
        else:
            hop = _hop(prev, curr, gap, link)
            hops.append(hop); seg_hops[-1].append(hop); segs[-1].append(curr)

    segments = []
    total_distance = 0
    total_travel = 0.0
    for i, seg in enumerate(segs):
        sh = seg_hops[i]
        mon = [h for h in sh if h["distance_meters"] is not None]
        dist = sum(h["distance_meters"] for h in mon)
        travel = sum(h["travel_time_seconds"] for h in mon)
        total_distance += dist
        total_travel += travel
        duration = (seg[-1]["spotted_at"] - seg[0]["spotted_at"]).total_seconds()
        codes: list[str] = []
        for r in seg:
            if not codes or codes[-1] != r["camera_code"]:
                codes.append(r["camera_code"])
        segments.append({
            "segment_index": i,
            "started_at": iso(seg[0]["spotted_at"]), "ended_at": iso(seg[-1]["spotted_at"]),
            "sighting_ids": [r["sighting_id"] for r in seg],
            "distance_meters": dist, "duration_seconds": int(duration),
            "average_speed_kph": round(dist / travel * 3.6, 1) if travel > 0 else None,
            "camera_codes": codes,
        })

    all_rows = accepted + excluded
    summary = {
        "sighting_count": len(all_rows),
        "accepted_count": len(accepted),
        "excluded_count": len(excluded),
        "distinct_camera_count": len({r["camera_id"] for r in accepted}),
        "first_seen_at": iso(min(r["spotted_at"] for r in all_rows)) if all_rows else None,
        "last_seen_at": iso(max(r["spotted_at"] for r in all_rows)) if all_rows else None,
        "total_distance_meters": total_distance,
        "total_duration_seconds": int(sum(s["duration_seconds"] for s in segments)),
        "average_speed_kph": round(total_distance / total_travel * 3.6, 1) if total_travel > 0 else None,
        "anomaly_hop_count": sum(1 for h in hops if h["hop_status"] in ("impossible_travel_time", "wrong_direction")),
        "unmonitored_hop_count": sum(1 for h in hops if h["hop_status"] == "no_link"),
        "segment_count": len(segs),
    }

    return {
        "plate": {"plate_id": plate_id, "normalized_plate": prow["normalized_plate"]},
        "window": window,
        "sightings": [sighting_row_to_dict(r) for r in accepted],
        "excluded_sightings": [sighting_row_to_dict(r) for r in excluded] if include_unvalidated else [],
        "hops": hops,
        "segments": segments,
        "summary": summary,
    }
