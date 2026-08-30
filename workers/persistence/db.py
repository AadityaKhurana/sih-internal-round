import json

import psycopg

from anpr_common import PlateSighting


def resolve_camera_id(
    conn: psycopg.Connection,
    camera_code: str,
):
    """
    Convert the camera's human-readable camera_code
    into the database camera_id UUID.
    """

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT camera_id
            FROM cameras
            WHERE camera_code = %s
            """,
            (camera_code,),
        )

        row = cur.fetchone()

        if row is None:
            raise ValueError(
                f"Unknown camera_code: {camera_code}"
            )

        return row[0]


def resolve_or_create_plate(
    conn: psycopg.Connection,
    normalized_plate: str | None,
):
    """
    Find an existing plate or create it.

    Returns None when OCR did not produce a normalized plate.
    """

    if not normalized_plate:
        return None

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO plates (normalized_plate)
            VALUES (%s)
            ON CONFLICT (normalized_plate)
            DO UPDATE SET normalized_plate = EXCLUDED.normalized_plate
            RETURNING plate_id
            """,
            (normalized_plate,),
        )

        row = cur.fetchone()

        if row is None:
            raise RuntimeError(
                f"Could not resolve plate: {normalized_plate}"
            )

        return row[0]


def insert_sighting(
    conn: psycopg.Connection,
    event: PlateSighting,
    camera_id,
    plate_id,
) -> None:
    """
    Persist one PlateSighting.

    source_event_id is the idempotency key.
    """

    media = event.media

    plate_crop_key = None
    vehicle_image_key = None
    context_clip_key = None

    if media is not None:
        plate_crop_key = media.plate_crop_object_key
        vehicle_image_key = media.vehicle_image_object_key
        context_clip_key = media.context_clip_object_key

    ocr_candidates = [
        candidate.model_dump()
        for candidate in event.ocr_candidates
    ]

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO sightings (
                source_event_id,
                camera_id,
                plate_id,
                raw_plate_text,
                normalized_plate_candidate,
                camera_track_id,
                detection_confidence,
                ocr_confidence,
                ocr_candidates,
                spotted_at,
                direction_degrees,
                vehicle_type,
                vehicle_color,
                lane_number,
                quality_flags,
                model_version,
                plate_crop_object_key,
                vehicle_image_object_key,
                context_clip_object_key
            )
            VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s,
                %s::jsonb, %s, %s, %s, %s, %s, %s, %s,
                %s::jsonb, %s, %s
            )
            ON CONFLICT (source_event_id)
            DO NOTHING
            """,
            (
                event.event_id,
                camera_id,
                plate_id,
                event.raw_plate_text,
                event.normalized_plate,
                event.camera_track_id,
                event.detection_confidence,
                event.ocr_confidence,
                json.dumps(ocr_candidates),
                event.captured_at,
                event.direction_degrees,
                event.vehicle_type,
                event.vehicle_color,
                event.lane_number,
                json.dumps(event.quality_flags),
                event.model_version,
                plate_crop_key,
                vehicle_image_key,
                context_clip_key,
            ),
        )


def validate_sighting(
    event: PlateSighting,
) -> tuple[str, str | None]:
    """
    Determine the initial validation state.

    The project contract defines the four possible states:
        pending / accepted / uncertain / conflict

    No project-specific acceptance thresholds were supplied,
    so we conservatively classify events as pending here.
    """

    return "pending", None