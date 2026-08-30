import json
import os
import time

import psycopg
import redis
from pydantic import ValidationError

from anpr_common import PlateSighting

from db import (
    insert_sighting,
    resolve_camera_id,
    resolve_or_create_plate,
    validate_sighting,
)

from redis_stream import (
    acknowledge,
    ensure_consumer_group,
    read_messages,
    reclaim_pending_messages,
    send_to_dlq,
)


DATABASE_URL = os.environ["DATABASE_URL"]
REDIS_URL = os.environ["REDIS_URL"]


def parse_event(fields: dict) -> PlateSighting:
    """
    Convert the Redis message into the canonical PlateSighting model.

    Expected Redis format:

        {
            "data": "<JSON representation of PlateSighting>"
        }
    """

    raw_data = fields.get("data")

    if raw_data is None:
        raise ValueError(
            "Redis message is missing 'data' field"
        )

    if isinstance(raw_data, bytes):
        raw_data = raw_data.decode("utf-8")

    try:
        payload = json.loads(raw_data)

    except json.JSONDecodeError as exc:
        raise ValueError(
            f"Invalid JSON: {exc}"
        ) from exc

    try:
        return PlateSighting.model_validate(payload)

    except ValidationError as exc:
        raise ValueError(
            f"PlateSighting validation failed: {exc}"
        ) from exc


def process_message(
    redis_client: redis.Redis,
    conn: psycopg.Connection,
    message_id: str,
    fields: dict,
) -> None:

    # ---------------------------------------------------------
    # 1. Parse + validate the event
    # ---------------------------------------------------------

    try:
        event = parse_event(fields)

    except ValueError as exc:

        print(
            f"[DLQ] message={message_id} "
            f"reason={exc}"
        )

        send_to_dlq(
            redis_client,
            message_id,
            fields,
            str(exc),
        )

        # We have deliberately handled the bad message.
        acknowledge(
            redis_client,
            message_id,
        )

        return

    print(
        f"[VALID] message={message_id} "
        f"event={event.event_id}"
    )

    # ---------------------------------------------------------
    # 2. Database transaction
    # ---------------------------------------------------------

    try:

        with conn.transaction():

            # Resolve camera_code -> camera_id
            camera_id = resolve_camera_id(
                conn,
                event.camera_code,
            )

            # Resolve normalized plate -> plate_id
            plate_id = resolve_or_create_plate(
                conn,
                event.normalized_plate,
            )

            # Determine initial validation state
            validation_status, validation_reason = (
                validate_sighting(event)
            )

            # Insert sighting
            insert_sighting(
                conn,
                event,
                camera_id,
                plate_id,
            )

            # Update validation state if necessary
            if validation_status != "pending":
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE sightings
                        SET
                            validation_status = %s,
                            validation_reason = %s
                        WHERE source_event_id = %s
                        """,
                        (
                            validation_status,
                            validation_reason,
                            event.event_id,
                        ),
                    )

        # -----------------------------------------------------
        # IMPORTANT:
        # PostgreSQL committed successfully BEFORE XACK.
        # -----------------------------------------------------

        acknowledge(
            redis_client,
            message_id,
        )

        print(
            f"[OK] event={event.event_id} "
            f"message={message_id}"
        )

    except ValueError as exc:

        # Permanent data problem, e.g. unknown camera.
        print(
            f"[DLQ] message={message_id} "
            f"reason={exc}"
        )

        send_to_dlq(
            redis_client,
            message_id,
            fields,
            str(exc),
        )

        acknowledge(
            redis_client,
            message_id,
        )

    except Exception as exc:

        # Temporary infrastructure/database problem.
        #
        # DO NOT ACK.
        #
        # Redis will keep the message pending.
        print(
            f"[RETRY] message={message_id} "
            f"error={exc}"
        )


def main():

    print("Starting persistence worker...")

    # ---------------------------------------------------------
    # Redis
    # ---------------------------------------------------------

    redis_client = redis.Redis.from_url(
        REDIS_URL,
        decode_responses=True,
    )

    # Actually verify the connection.
    redis_client.ping()

    print("Redis client created")

    ensure_consumer_group(redis_client)

    print("Redis consumer group ready")

    # ---------------------------------------------------------
    # PostgreSQL
    # ---------------------------------------------------------

    with psycopg.connect(DATABASE_URL) as conn:

        print("PostgreSQL connection successful")
        print("Waiting for plate sightings...")

        # -----------------------------------------------------
        # Main consumer loop
        # -----------------------------------------------------

        last_reclaim = 0

        while True:

            # Recover messages abandoned by a crashed worker.
            now = time.monotonic()

            if now - last_reclaim >= 10:

                pending = reclaim_pending_messages(redis_client)

                if pending:
                    _, entries, _ = pending

                    for message_id, fields in entries:
                        process_message(
                            redis_client,
                            conn,
                            message_id,
                            fields,
                        )

                last_reclaim = now

         # Read brand-new messages.
            messages = read_messages(redis_client)

            if not messages:
                continue

            for stream_name, entries in messages:

                for message_id, fields in entries:
                    process_message(
                        redis_client,
                        conn,
                        message_id,
                        fields,
                )


if __name__ == "__main__":
    main()