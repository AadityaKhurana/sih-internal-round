from dataclasses import dataclass

from ultralytics import YOLO

from .config import (
    YOLO_MODEL,
    PLATE_MODEL,
    VEHICLE_CONFIDENCE,
    PLATE_CONFIDENCE,
)


@dataclass
class Detection:
    bbox: tuple[int, int, int, int]
    confidence: float
    class_name: str


class Detector:
    def __init__(self):
        self.vehicle_model = YOLO(YOLO_MODEL)
        self.plate_model = YOLO(PLATE_MODEL)

    def detect_vehicles(self, frame):
        results = self.vehicle_model(
            frame,
            conf=VEHICLE_CONFIDENCE,
            verbose=False,
        )

        detections = []

        for result in results:
            if result.boxes is None:
                continue

            for box in result.boxes:
                x1, y1, x2, y2 = map(
                    int,
                    box.xyxy[0].tolist(),
                )

                confidence = float(box.conf[0])

                class_id = int(box.cls[0])
                class_name = self.vehicle_model.names[class_id]

                detections.append(
                    Detection(
                        bbox=(x1, y1, x2, y2),
                        confidence=confidence,
                        class_name=class_name,
                    )
                )

        return detections

    def detect_plates(self, frame):
        results = self.plate_model(
            frame,
            conf=PLATE_CONFIDENCE,
            verbose=False,
        )

        detections = []

        for result in results:
            if result.boxes is None:
                continue

            for box in result.boxes:
                x1, y1, x2, y2 = map(
                    int,
                    box.xyxy[0].tolist(),
                )

                confidence = float(box.conf[0])

                detections.append(
                    Detection(
                        bbox=(x1, y1, x2, y2),
                        confidence=confidence,
                        class_name="license_plate",
                    )
                )

        return detections