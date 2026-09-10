# ====================================================================
# LANE C OCR - commented out during lane integration.
# OCR is owned by Lane A (active in main). Lane C's parallel OCR module
# is preserved VERBATIM but inert here, not discarded.
# Restore by uncommenting and reconciling with workers/ocr/detector.py.
# ====================================================================

# import os
#
# REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
#
# # Redis channel consumed by persistence worker
# SIGHTINGS_CHANNEL = os.getenv(
#     "SIGHTINGS_CHANNEL",
#     "plate_sightings",
# )
#
# # Input video for now
# VIDEO_PATH = os.getenv(
#     "OCR_VIDEO_PATH",
#     "data/test.mp4",
# )
#
# # Models
# YOLO_MODEL = os.getenv(
#     "YOLO_MODEL",
#     "yolo11n.pt",
# )
#
# PLATE_MODEL = os.getenv(
#     "PLATE_MODEL",
#     "models/license_plate.pt",
# )
#
# # Detection thresholds
# VEHICLE_CONFIDENCE = float(
#     os.getenv("VEHICLE_CONFIDENCE", "0.40")
# )
#
# PLATE_CONFIDENCE = float(
#     os.getenv("PLATE_CONFIDENCE", "0.40")
# )
#
# OCR_CONFIDENCE = float(
#     os.getenv("OCR_CONFIDENCE", "0.50")
# )
#
# # Voting
# MIN_VOTES = int(
#     os.getenv("OCR_MIN_VOTES", "3")
# )
#
# TRACK_MAX_AGE = int(
#     os.getenv("OCR_TRACK_MAX_AGE", "15")
# )
#
# # Camera identity
# CAMERA_CODE = os.getenv(
#     "CAMERA_CODE",
#     "CAM01",
# )
