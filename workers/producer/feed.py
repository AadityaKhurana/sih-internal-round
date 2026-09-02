"""Demo producer — synthetic stand-in for the OCR lane.

Real OCR (YOLO + PaddleOCR) needs model weights, a GPU and video, so for a
runnable demo this emits the SAME `PlateSighting` contract the OCR worker would,
onto the same `plate_sightings` stream. Nothing downstream can tell the
difference — that is the whole point of integrating at the event boundary.
"""
import json
import os
import random
import time
import uuid
from datetime import datetime, timezone

import redis

from anpr_common import PlateSighting

REDIS_URL = os.environ["REDIS_URL"]
INTERVAL = float(os.getenv("PRODUCER_INTERVAL_SECONDS", "3"))

CAMERAS = ["CAM-01", "CAM-02", "CAM-03", "CAM-04", "CAM-05", "CAM-06", "CAM-07", "CAM-08"]
# DL8CAF5678 is blacklisted in the Dwarka seed -> exercises the alerts worker live.
PLATES = ["DL3CAB1234", "DL1CAA0007", "DL8CAF5678", "DL4CAD9012", "DL2CAE3456"]


def main() -> None:
    r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    r.ping()
    print(f"demo producer started (interval={INTERVAL}s)", flush=True)
    i = 0
    while True:
        cam = random.choice(CAMERAS)
        plate = random.choice(PLATES)
        event = PlateSighting(
            event_id=f"demo-{uuid.uuid4().hex[:12]}",
            camera_code=cam,
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
            direction_degrees=90,
            quality_flags={},
            model_version="demo-producer-v1",
        )
        r.xadd("plate_sightings", {"data": json.dumps(event.model_dump(mode="json"))})
        print(f"published {event.event_id} {cam} {plate}", flush=True)
        i += 1
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
