import json
import os
from datetime import datetime, timezone

import redis

from anpr_common import PlateSighting


REDIS_URL = os.environ["REDIS_URL"]


def main():

    r = redis.Redis.from_url(
        REDIS_URL,
        decode_responses=True,
    )

    event = PlateSighting(
        event_id="test-event-001",
        camera_code="CAM01",
        captured_at=datetime.now(timezone.utc),
        raw_plate_text="DL01AB1234",
        normalized_plate="DL01AB1234",
        detection_confidence=0.94,
        ocr_confidence=0.94,
        ocr_candidates=[],
        camera_track_id="test-track-001",
        vehicle_type="car",
        vehicle_color="white",
        lane_number=1,
        direction_degrees=90,
        quality_flags={},
        model_version="test-model-v1",
    )

    message_id = r.xadd(
        "plate_sightings",
        {
            "data": json.dumps(
                event.model_dump(mode="json")
            )
        },
    )

    print(
        f"Published test event: {message_id}"
    )


if __name__ == "__main__":
    main()