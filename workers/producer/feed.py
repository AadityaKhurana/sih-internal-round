"""Demo producer — synthetic stand-in for the OCR lane.

Real OCR (YOLO + PaddleOCR) needs model weights, a GPU and video, so for a
runnable demo this emits the SAME `PlateSighting` contract the OCR worker would,
onto the same `plate_sightings` stream. Nothing downstream can tell the
difference — that is the whole point of integrating at the event boundary.

Data comes in AS CAMERAS (per-approach camera codes); the backend post-processes
each up to its junction. To keep the LIVE alert feed clean, plates drive
REALISTIC CORRIDOR TRIPS: a fleet of plates each walk a path of ADJACENT
junctions, and consecutive sightings of a plate are spaced by the connecting
link's real free-flow time — so every hop is physically feasible and the
impossible-travel detector does not false-fire. Each trip uses a fresh plate
(no cross-trip teleport); the blacklisted plate walks continuously so blacklist
alerts fire without spurious anomalies.
"""
import json
import os
import random
import time
import uuid
from datetime import datetime, timezone

import psycopg
import redis

from anpr_common import PlateSighting

REDIS_URL = os.environ["REDIS_URL"]
DATABASE_URL = os.environ["DATABASE_URL"]
FLEET = int(os.getenv("PRODUCER_FLEET", "12"))          # concurrent plate trips
SCAN = float(os.getenv("PRODUCER_SCAN_SECONDS", "2"))   # scheduler tick
BLACK = "DL8CAF5678"                                    # blacklisted in the seed
_LET = "ABDEFGHJKLMNPRSTUVWXYZ"


def rand_plate():
    return f"DL{random.randint(1,9)}C{random.choice(_LET)}{random.randint(1000,9999)}"


def load_graph():
    """Return (jcodes, jname, adj, arm_cam, by_junction).

    adj[code]      = [(neighbour_code, free_flow_seconds), ...]
    arm_cam[(J,from_name)] = (camera_code, travel_degrees)   # camera watching that arm
    by_junction[J] = [(camera_code, travel_degrees), ...]
    """
    with psycopg.connect(DATABASE_URL) as conn, conn.cursor() as cur:
        cur.execute("SELECT camera_code, display_name FROM cameras")
        jname = {code: name for code, name in cur.fetchall()}
        jcodes = list(jname)

        adj = {}
        cur.execute(
            """
            SELECT cf.camera_code, ct.camera_code, COALESCE(cl.free_flow_time_seconds, 60)
            FROM camera_links cl
            JOIN cameras cf ON cf.camera_id = cl.from_camera_id
            JOIN cameras ct ON ct.camera_id = cl.to_camera_id
            """
        )
        for f, t, ff in cur.fetchall():
            adj.setdefault(f, []).append((t, int(ff)))

        arm_cam, by_junction = {}, {}
        cur.execute("SELECT to_regclass('approach_cameras')")
        if cur.fetchone()[0] is not None:
            cur.execute(
                "SELECT camera_code, junction_code, from_road, COALESCE(travel_degrees, 90) FROM approach_cameras"
            )
            for code, jc, frm, travel in cur.fetchall():
                arm_cam[(jc, frm)] = (code, int(travel))
                by_junction.setdefault(jc, []).append((code, int(travel)))
        return jcodes, jname, adj, arm_cam, by_junction


def make_path(start, adj, min_hops=4, max_hops=8):
    cur, prev, path = start, None, [start]
    for _ in range(random.randint(min_hops, max_hops)):
        nbrs = [nb for nb, _ in adj.get(cur, []) if nb != prev]
        if not nbrs:
            break
        nb = random.choice(nbrs)
        path.append(nb); prev, cur = cur, nb
    return path


def ff_between(a, b, adj):
    for nb, ff in adj.get(a, []):
        if nb == b:
            return max(5, ff)
    return 60


def camera_for(J, from_name, arm_cam, by_junction):
    """Camera watching junction J's arm from `from_name`; fall back to any at J,
    else the junction node itself (persistence maps it to the junction)."""
    if from_name is not None and (J, from_name) in arm_cam:
        return arm_cam[(J, from_name)]
    if by_junction.get(J):
        return random.choice(by_junction[J])
    return (J, 90)


def main() -> None:
    r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    r.ping()

    graph = None
    while graph is None or not graph[0]:
        try:
            graph = load_graph()
        except Exception as e:
            print(f"waiting for network: {e}", flush=True)
        if graph is None or not graph[0]:
            time.sleep(3)
    jcodes, jname, adj, arm_cam, by_junction = graph
    linked = [c for c in jcodes if adj.get(c)] or jcodes
    print(f"demo producer: {len(jcodes)} junctions, fleet={FLEET}, corridor trips", flush=True)

    def new_trip(plate, start=None):
        start = start or random.choice(linked)
        return {"plate": plate, "path": make_path(start, adj), "idx": 0,
                "due": time.time() + random.uniform(0, 15)}

    fleet = [new_trip(BLACK)] + [new_trip(rand_plate()) for _ in range(max(0, FLEET - 1))]
    i = 0
    while True:
        now = time.time()
        for t in fleet:
            if now < t["due"]:
                continue
            idx = t["idx"]
            J = t["path"][idx]
            from_name = jname.get(t["path"][idx - 1]) if idx > 0 else None
            code, travel = camera_for(J, from_name, arm_cam, by_junction)
            event = PlateSighting(
                event_id=f"demo-{uuid.uuid4().hex[:12]}",
                camera_code=code,
                captured_at=datetime.now(timezone.utc),
                raw_plate_text=t["plate"],
                normalized_plate=t["plate"],
                detection_confidence=0.96,
                ocr_confidence=0.95,
                ocr_candidates=[{"plate": t["plate"], "confidence": 0.95}],
                camera_track_id=f"demo-{t['plate']}",
                vehicle_type="car",
                vehicle_color=random.choice(["white", "black", "silver", "blue"]),
                lane_number=random.randint(1, 3),
                direction_degrees=int(travel),
                quality_flags={},
                model_version="demo-producer-v1",
            )
            r.xadd("plate_sightings", {"data": json.dumps(event.model_dump(mode="json"))})
            print(f"published {t['plate']} @ {code} (junction {J})", flush=True)
            i += 1

            if idx + 1 < len(t["path"]):
                t["due"] = now + ff_between(J, t["path"][idx + 1], adj)
                t["idx"] = idx + 1
            elif t["plate"] == BLACK:
                # keep the blacklisted plate moving from where it is (stays feasible)
                t["path"], t["idx"], t["due"] = make_path(J, adj), 0, now + ff_between(
                    J, (adj.get(J) or [(J, 60)])[0][0], adj)
            else:
                t.update(new_trip(rand_plate()))
        time.sleep(SCAN)


if __name__ == "__main__":
    main()
