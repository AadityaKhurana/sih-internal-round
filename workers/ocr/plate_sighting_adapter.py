"""
Detection half of the `PlateSighting` contract.

The OCR worker is two stages:

    frames -> [detection: this module] -> ranked crops -> [recognition] -> PlateSighting

`detector.py` emits an internal event carrying up to five ranked plate crops.
That event is NOT the wire format -- the contract in `common/anpr_common` is
published *after* multi-frame voting, so the recognition stage completes it.

This module fills every field the detection stage owns, so recognition only
has to add `raw_plate_text`, `normalized_plate`, `ocr_confidence` and
`ocr_candidates`.

See docs/plate_sighting_event.md for the canonical field reference.
"""
from __future__ import annotations

from datetime import datetime, timezone

# COCO gives "motorcycle"; the contract's enum is "two_wheeler". Mapping here
# rather than downstream means the alert and analytics workers never see a
# vehicle_type they don't recognise.
COCO_TO_CONTRACT = {
    "car": "car",
    "truck": "truck",
    "bus": "bus",
    "motorcycle": "two_wheeler",
}

# Below this, a plate crop is too small to read. Used as a quality flag, not
# as a reason to drop the event -- unread passes still count toward density.
UNREADABLE_PLATE_PX = 60


def event_id(camera_code: str, track_id: int, captured_at: datetime) -> str:
    """
    Contract convention: <camera>-<track>-<UTC compact ts>.

    This is the idempotency key (sightings.source_event_id is UNIQUE), so it
    must be stable for a given vehicle pass and unique across all others.
    """
    ts = captured_at.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%S")
    return f"{camera_code}-track{track_id}-{ts}"


def to_compass_bearing(image_bearing_deg, camera_heading_deg):
    """
    Convert an image-space bearing to a compass bearing.

    The detector measures direction in IMAGE space: 0 deg is up the frame,
    90 deg is right. The contract's `direction_degrees` is a compass heading
    and drives the `wrong_direction` anomaly, so publishing the raw image
    bearing would make that alert fire on nothing.

    `camera_heading_deg` is the direction the camera faces
    (cameras.heading_degrees in the schema). A vehicle moving "up the frame"
    is moving away from the camera, i.e. along the camera's heading.
    """
    if image_bearing_deg is None or camera_heading_deg is None:
        return None
    return round((float(image_bearing_deg) + float(camera_heading_deg)) % 360, 2)


def quality_flags(event, night: bool | None = None) -> dict:
    """
    Free-form booleans the contract stores as jsonb.

    Only flags we can actually measure are emitted. `night` comes from the
    ingest stage (scene luminance) if available; omitted rather than guessed.
    """
    flags = {}
    w = event.get("best_plate_width_px") or 0
    if w:
        flags["low_resolution"] = w < UNREADABLE_PLATE_PX
    if event.get("plate_status") == "NO_PLATE":
        flags["no_plate_detected"] = True
    if event.get("track_frames", 0) <= 6:
        # short tracks mean the vehicle crossed fast or was clipped by the
        # frame edge -- both correlate with motion blur
        flags["short_track"] = True
    if night is not None:
        flags["night"] = bool(night)
    return flags


def detection_fields(event, camera_code: str, camera_heading_deg=None,
                     night: bool | None = None) -> dict:
    """
    Every PlateSighting field the DETECTION stage owns.

    The recognition stage merges its own output over this and constructs the
    PlateSighting model:

        from anpr_common import PlateSighting
        payload = {**detection_fields(ev, "CAM-12", heading), **ocr_fields}
        sighting = PlateSighting(**payload)

    Returns a plain dict, not a model, precisely because it is incomplete --
    PlateSighting has required OCR fields and would fail validation here.
    """
    captured = datetime.fromisoformat(event["event_ts"])

    best_crop = None
    uris = event.get("plate_crop_uris") or []
    if uris:
        best_crop = uris[0]          # rank 0 = highest quality score

    return {
        "schema_version": 1,
        "event_id": event_id(camera_code, event["track_id"], captured),
        "camera_code": camera_code,
        # contract requires UTC with Z; the detector stamps local offset
        "captured_at": captured.astimezone(timezone.utc),
        "detection_confidence": event.get("detection_confidence", 0.0),
        "camera_track_id": str(event["track_id"]),
        "vehicle_type": COCO_TO_CONTRACT.get(event.get("vehicle_class")),
        "direction_degrees": to_compass_bearing(
            event.get("direction_bearing_img_deg"), camera_heading_deg),
        "quality_flags": quality_flags(event, night=night),
        "model_version": event.get("model", {}).get("detector", "unknown"),
        "media": {"plate_crop_object_key": best_crop} if best_crop else None,
    }
