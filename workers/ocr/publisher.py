import json
import uuid
from datetime import datetime, timezone

import redis

from .config import (
    REDIS_URL,
    SIGHTINGS_CHANNEL,
)


class SightingsPublisher:
    def __init__(self):
        self.redis = redis.Redis.from_url(
            REDIS_URL,
            decode_responses=True,
        )

    def publish(
        self,
        *,
        camera_code,
        track_id,
        plate,
        spotted_at,
        detection_confidence,
        ocr_confidence,
        candidates,
        vehicle_type=None,
    ):
        event = {
            "event_id": str(uuid.uuid4()),
            "event_type": "PlateSighting",
            "timestamp": datetime.now(
                timezone.utc
            ).isoformat(),

            "camera_code": camera_code,
            "camera_track_id": track_id,

            "raw_plate_text": plate,
            "normalized_plate_candidate": plate,

            "detection_confidence":
                detection_confidence,

            "ocr_confidence":
                ocr_confidence,

            "ocr_candidates": candidates,

            "spotted_at":
                spotted_at.isoformat(),

            "vehicle_type": vehicle_type,

            "quality_flags": {},

            "model_version":
                "yolo+paddleocr",
        }

        self.redis.publish(
            SIGHTINGS_CHANNEL,
            json.dumps(event),
        )

        return event