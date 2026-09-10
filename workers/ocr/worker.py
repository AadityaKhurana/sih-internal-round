# ====================================================================
# LANE C OCR - commented out during lane integration.
# OCR is owned by Lane A (active in main). Lane C's parallel OCR module
# is preserved VERBATIM but inert here, not discarded.
# Restore by uncommenting and reconciling with workers/ocr/detector.py.
# ====================================================================

# import cv2
# from datetime import datetime, timezone
#
# from .config import (
#     VIDEO_PATH,
#     CAMERA_CODE,
#     MIN_VOTES,
# )
#
# from .detector import Detector
# from .recognizer import PlateRecognizer
# from .tracker import VehicleTracker
# from .voting import PlateVoter
# from .normalizer import normalize_plate
# from .publisher import SightingsPublisher
#
#
# def crop(frame, bbox):
#     x1, y1, x2, y2 = bbox
#
#     h, w = frame.shape[:2]
#
#     x1 = max(0, x1)
#     y1 = max(0, y1)
#     x2 = min(w, x2)
#     y2 = min(h, y2)
#
#     if x2 <= x1 or y2 <= y1:
#         return None
#
#     return frame[y1:y2, x1:x2]
#
#
# def main():
#     print("Starting OCR worker...")
#
#     detector = Detector()
#     recognizer = PlateRecognizer()
#     tracker = VehicleTracker()
#
#     voter = PlateVoter(
#         min_votes=MIN_VOTES
#     )
#
#     publisher = SightingsPublisher()
#
#     cap = cv2.VideoCapture(
#         VIDEO_PATH
#     )
#
#     if not cap.isOpened():
#         raise RuntimeError(
#             f"Could not open video: {VIDEO_PATH}"
#         )
#
#     print(
#         f"Processing video: {VIDEO_PATH}"
#     )
#
#     while True:
#         success, frame = cap.read()
#
#         if not success:
#             break
#
#         spotted_at = datetime.now(
#             timezone.utc
#         )
#
#         tracks = tracker.track(frame)
#
#         plates = detector.detect_plates(
#             frame
#         )
#
#         for track in tracks:
#             track_id = track["track_id"]
#             vehicle_bbox = track["bbox"]
#
#             vx1, vy1, vx2, vy2 = vehicle_bbox
#
#             # Find plates whose center lies
#             # inside this vehicle.
#             matched_plate = None
#
#             for plate in plates:
#                 px1, py1, px2, py2 = (
#                     plate.bbox
#                 )
#
#                 center_x = (
#                     px1 + px2
#                 ) // 2
#
#                 center_y = (
#                     py1 + py2
#                 ) // 2
#
#                 if (
#                     vx1 <= center_x <= vx2
#                     and
#                     vy1 <= center_y <= vy2
#                 ):
#                     if (
#                         matched_plate is None
#                         or plate.confidence
#                         > matched_plate.confidence
#                     ):
#                         matched_plate = plate
#
#             if matched_plate is None:
#                 continue
#
#             plate_crop = crop(
#                 frame,
#                 matched_plate.bbox,
#             )
#
#             if plate_crop is None:
#                 continue
#
#             result = recognizer.recognize(
#                 plate_crop
#             )
#
#             if result is None:
#                 continue
#
#             raw_text = result["text"]
#
#             normalized = normalize_plate(
#                 raw_text
#             )
#
#             if normalized is None:
#                 continue
#
#             vote = voter.add(
#                 track_id,
#                 normalized,
#                 result["confidence"],
#             )
#
#             if vote is None:
#                 continue
#
#             # Prevent repeatedly publishing
#             # the same winning plate for a track.
#             if getattr(
#                 voter,
#                 "_published",
#                 None,
#             ) is None:
#                 voter._published = set()
#
#             key = (
#                 track_id,
#                 vote["plate"],
#             )
#
#             if key in voter._published:
#                 continue
#
#             voter._published.add(key)
#
#             event = publisher.publish(
#                 camera_code=CAMERA_CODE,
#                 track_id=track_id,
#                 plate=vote["plate"],
#                 spotted_at=spotted_at,
#                 detection_confidence=(
#                     matched_plate.confidence
#                 ),
#                 ocr_confidence=(
#                     vote["confidence"]
#                 ),
#                 candidates=vote[
#                     "candidates"
#                 ],
#             )
#
#             print(
#                 "[PUBLISHED]",
#                 event,
#             )
#
#     cap.release()
#
#     print("OCR worker finished.")
#
#
# if __name__ == "__main__":
#     main()
