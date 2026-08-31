from ultralytics import YOLO

from .config import YOLO_MODEL


class VehicleTracker:
    def __init__(self):
        self.model = YOLO(YOLO_MODEL)

    def track(self, frame):
        results = self.model.track(
            frame,
            persist=True,
            verbose=False,
        )

        tracks = []

        for result in results:
            if result.boxes is None:
                continue

            ids = result.boxes.id

            if ids is None:
                continue

            for box, track_id in zip(
                result.boxes,
                ids,
            ):
                x1, y1, x2, y2 = map(
                    int,
                    box.xyxy[0].tolist(),
                )

                tracks.append(
                    {
                        "track_id": str(
                            int(track_id)
                        ),
                        "bbox": (
                            x1,
                            y1,
                            x2,
                            y2,
                        ),
                    }
                )

        return tracks