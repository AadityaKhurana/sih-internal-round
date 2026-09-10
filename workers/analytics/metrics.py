from statistics import median

from .config import (
    CONGESTION_SIGNIFICANT_RATIO,
    TRAFFIC_VOLUME_SIGNIFICANT_RATIO,
)


def calculate_camera_metrics(
    conn,
    camera_id,
    window_start,
    window_end,
):
    """
    Calculate node-level metrics for one camera.
    """

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                COUNT(*) AS vehicle_count,
                COUNT(DISTINCT plate_id) AS unique_plate_count
            FROM sightings
            WHERE camera_id = %s
              AND validation_status = 'accepted'
              AND spotted_at >= %s
              AND spotted_at < %s
            """,
            (
                camera_id,
                window_start,
                window_end,
            ),
        )

        vehicle_count, unique_plate_count = cur.fetchone()

    return {
        "vehicle_count": vehicle_count,
        "unique_plate_count": unique_plate_count,
        "significant_change": False,
    }


def calculate_link_metrics(
    conn,
    camera_link_id,
    from_camera_id,
    to_camera_id,
    window_start,
    window_end,
):
    """
    Calculate link-level metrics.
    """

    # Number of vehicles entering the link.
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                COUNT(*) AS vehicle_count,
                COUNT(DISTINCT plate_id) AS unique_vehicle_count
            FROM sightings
            WHERE camera_id = %s
              AND validation_status = 'accepted'
              AND spotted_at >= %s
              AND spotted_at < %s
            """,
            (
                from_camera_id,
                window_start,
                window_end,
            ),
        )

        vehicle_count, unique_vehicle_count = cur.fetchone()

    # Match the vehicles at both ends of the link.
    from .journeys import get_link_journeys

    travel_times = get_link_journeys(
        conn,
        from_camera_id,
        to_camera_id,
        window_start,
        window_end,
    )

    median_travel_time = (
        int(median(travel_times))
        if travel_times
        else None
    )

    return {
        "vehicle_count": vehicle_count,
        "unique_vehicle_count": unique_vehicle_count,
        "median_travel_time_seconds": median_travel_time,
        "travel_time_sample_count": len(travel_times),
    }


def calculate_congestion_score(
    median_travel_time_seconds,
    baseline_travel_time_seconds,
):
    """
    congestion_score = observed travel time / baseline travel time.

    Examples:

        100 / 100 = 1.0
        150 / 100 = 1.5
        200 / 100 = 2.0
    """

    if (
        median_travel_time_seconds is None
        or baseline_travel_time_seconds is None
        or baseline_travel_time_seconds <= 0
    ):
        return None

    return round(
        median_travel_time_seconds
        / baseline_travel_time_seconds,
        3,
    )


def is_significant_change(
    congestion_score,
    vehicle_count,
    baseline_vehicle_count,
):
    """
    Determine whether the current window represents
    a significant change from baseline.
    """

    congestion_change = False
    volume_change = False

    if congestion_score is not None:
        congestion_change = (
            congestion_score >= CONGESTION_SIGNIFICANT_RATIO
        )

    if (
        baseline_vehicle_count is not None
        and baseline_vehicle_count > 0
    ):
        volume_change = (
            vehicle_count
            >= baseline_vehicle_count
            * TRAFFIC_VOLUME_SIGNIFICANT_RATIO
        )

    return congestion_change or volume_change