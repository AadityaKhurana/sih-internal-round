import redis


STREAM_NAME = "plate_sightings"
DLQ_STREAM_NAME = "plate_sightings.dlq"

GROUP_NAME = "persistence-workers"
CONSUMER_NAME = "persistence-1"


def ensure_consumer_group(r: redis.Redis) -> None:
    """Create the persistence consumer group if it does not exist."""
    try:
        r.xgroup_create(
            name=STREAM_NAME,
            groupname=GROUP_NAME,
            id="0",
            mkstream=True,
        )
        print(f"Created consumer group: {GROUP_NAME}")

    except redis.exceptions.ResponseError as exc:
        if "BUSYGROUP" in str(exc):
            print(f"Consumer group already exists: {GROUP_NAME}")
        else:
            raise


def read_messages(r: redis.Redis):
    """Read new messages from the stream."""

    try:
        return r.xreadgroup(
            groupname=GROUP_NAME,
            consumername=CONSUMER_NAME,
            streams={STREAM_NAME: ">"},
            count=10,
            block=5000,
        )

    except redis.exceptions.TimeoutError:
        # No message arrived during the blocking period.
        return []

def reclaim_pending_messages(r: redis.Redis):
    """
    Reclaim messages that have been pending for too long.

    This handles messages that were delivered to a worker but never
    acknowledged because the worker crashed or lost its connection.
    """

    try:
        return r.xautoclaim(
            name=STREAM_NAME,
            groupname=GROUP_NAME,
            consumername=CONSUMER_NAME,
            min_idle_time=30_000,  # 30 seconds
            start_id="0-0",
            count=10,
        )

    except redis.exceptions.ResponseError as exc:
        print(f"Could not reclaim pending messages: {exc}")
        return None
    

def acknowledge(r: redis.Redis, message_id: str) -> None:
    """Acknowledge a successfully handled message."""

    r.xack(
        STREAM_NAME,
        GROUP_NAME,
        message_id,
    )


def send_to_dlq(
    r: redis.Redis,
    message_id: str,
    fields: dict,
    reason: str,
) -> None:
    """Move an invalid/unprocessable event to the DLQ."""

    r.xadd(
        DLQ_STREAM_NAME,
        {
            "original_stream": STREAM_NAME,
            "original_message_id": message_id,
            "reason": reason,
            "payload": str(fields),
        },
    )