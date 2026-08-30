from datetime import timedelta

from .config import MAX_JOURNEY_SECONDS


def get_link_journeys(
    conn,
    from_camera_id,
    to_camera_id,
    window_start,
    window_end,
):
    """
    Match accepted sightings at both ends of a camera link.

    A journey is valid when:

        same plate
        source camera = link.from_camera
        destination camera = link.to_camera
        destination sighting occurs after source sighting
        destination occurs within MAX_JOURNEY_SECONDS

    The source sighting must belong to the analytics window.

    Returns:
        list of travel times in seconds
    """

    max_destination_time = (
        window_end + timedelta(seconds=MAX_JOURNEY_SECONDS)
    )

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                EXTRACT(
                    EPOCH FROM (
                        destination.spotted_at -
                        source.spotted_at
                    )
                ) AS travel_time
            FROM sightings source

            JOIN sightings destination
              ON destination.plate_id = source.plate_id
             AND destination.camera_id = %s
             AND destination.validation_status = 'accepted'
             AND destination.spotted_at > source.spotted_at
             AND destination.spotted_at <= %s

            WHERE source.camera_id = %s
              AND source.validation_status = 'accepted'
              AND source.spotted_at >= %s
              AND source.spotted_at < %s

            ORDER BY source.spotted_at
            """,
            (
                to_camera_id,
                max_destination_time,
                from_camera_id,
                window_start,
                window_end,
            ),
        )

        travel_times = []

        for row in cur.fetchall():
            if row[0] is None:
                continue

            travel_time = int(row[0])

            if travel_time > 0:
                travel_times.append(travel_time)

        return travel_times