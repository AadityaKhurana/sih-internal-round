"""Demo producer — synthetic stand-in for the OCR lane.

Real OCR (YOLO + PaddleOCR) needs model weights, a GPU and video, so for a
runnable demo this emits the SAME `PlateSighting` contract the OCR worker would,
onto the same `plate_sightings` stream. Nothing downstream can tell the
difference — that is the whole point of integrating at the event boundary.

Data comes in AS CAMERAS: events are keyed by a per-approach camera code (loaded
from the behind-the-scenes `approach_cameras` table), carrying that camera's
travel direction. The backend (persistence) post-processes each camera event up
to its junction. Falls back to junction nodes if approach_cameras is empty.
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
INTERVAL = float(os.getenv("PRODUCER_INTERVAL_SECONDS", "3"))
REFRESH_EVERY = 50  # reload the camera list every N emits (picks up reseeds)

# DL8CAF5678 is blacklisted in the Dwarka seed -> exercises the alerts worker live.
PLATES = ["DL3CAB1234", "DL1CAA0007", "DL8CAF5678", "DL4CAD9012", "DL2CAE3456"]


def load_cameras():
    """Return [(camera_code, travel_degrees), ...] from the real cameras, else junctions."""
    with psycopg.connect(DATABASE_URL) as conn, conn.cursor() as cur:
        cur.execute("SELECT to_regclass('approach_cameras')")
        if cur.fetchone()[0] is not None:
            cur.execute("SELECT camera_code, COALESCE(travel_degrees, 90) FROM approach_cameras")
            rows = cur.fetchall()
            if rows:
                return rows
        cur.execute("SELECT camera_code, COALESCE(heading_degrees, 90) FROM cameras")
        return cur.fetchall()


def main() -> None:
    r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    r.ping()

    cams = []
    while not cams:
        try:
            cams = load_cameras()
        except Exception as e:  # DB not seeded yet
            print(f"waiting for cameras: {e}", flush=True)
        if not cams:
            time.sleep(3)
    print(f"demo producer started (interval={INTERVAL}s, {len(cams)} cameras)", flush=True)

    i = 0
    while True:
        if i and i % REFRESH_EVERY == 0:
            try:
                fresh = load_cameras()
                if fresh:
                    cams = fresh
            except Exception:
                pass
        code, travel = random.choice(cams)
        plate = random.choice(PLATES)
        event = PlateSighting(
            event_id=f"demo-{uuid.uuid4().hex[:12]}",
            camera_code=code,
            captured_at=datetime.now(timezone.utc),
            raw_plate_text=plate,
            normalized_plate=plate,
            detection_confidence=0.96,
            ocr_confidence=0.95,
            ocr_candidates=[{"plate": plate, "confidence": 0.95}],
            camera_track_id=f"demo-track-{i}",
            vehicle_type="car",
            vehicle_color=random.choice(["white", "black", "silver", "blue"]),
            lane_number=random.randint(1, 3),
            direction_degrees=int(travel),
            quality_flags={},
            model_version="demo-producer-v1",
        )
        r.xadd("plate_sightings", {"data": json.dumps(event.model_dump(mode="json"))})
        print(f"published {event.event_id} {code} {plate}", flush=True)
        i += 1
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
