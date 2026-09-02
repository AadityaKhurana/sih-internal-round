import time
from datetime import datetime, timedelta, timezone

from .config import POLL_INTERVAL_SECONDS
from .db import (
    get_baseline,
    get_camera_links,
    get_cameras,
    get_connection,
    get_latest_processed_window,
    insert_camera_metric,
    insert_traffic_metric,
)
from .metrics import (
    calculate_camera_metrics,
    calculate_congestion_score,
    calculate_link_metrics,
    is_significant_change,
)


def floor_to_five_minutes(dt):
    """
    Align a timestamp to the beginning of its 5-minute window.

    Example:

        12:03:42 → 12:00:00
        12:07:15 → 12:05:00
    """

    dt = dt.astimezone(timezone.utc)

    return dt.replace(
        minute=(dt.minute // 5) * 5,
        second=0,
        microsecond=0,
    )


def get_latest_completed_window():
    """
    Return the most recent fully completed 5-minute window.
    """

    now = datetime.now(timezone.utc)

    current_window = floor_to_five_minutes(now)

    return current_window - timedelta(minutes=5)


def process_window(conn, window_start):
    """
    Process one complete 5-minute analytics window.
    """

    window_end = window_start + timedelta(minutes=5)

    print(
        f"Processing analytics window "
        f"{window_start} → {window_end}"
    )

    cameras = get_cameras(conn)

    # ---------------------------------------------------------
    # CAMERA / NODE METRICS
    # ---------------------------------------------------------

    for camera_id in cameras:

        metrics = calculate_camera_metrics(
            conn,
            camera_id,
            window_start,
            window_end,
        )

        insert_camera_metric(
            conn,
            camera_id,
            window_start,
            metrics["vehicle_count"],
            metrics["unique_plate_count"],
            metrics["significant_change"],
        )

    # ---------------------------------------------------------
    # LINK METRICS
    # ---------------------------------------------------------

    links = get_camera_links(conn)

    for (
        camera_link_id,
        from_camera_id,
        to_camera_id,
        distance_meters,
        free_flow_time_seconds,
    ) in links:

        metrics = calculate_link_metrics(
            conn,
            camera_link_id,
            from_camera_id,
            to_camera_id,
            window_start,
            window_end,
        )

        (
            baseline_travel_time,
            baseline_vehicle_count,
        ) = get_baseline(
            conn,
            camera_link_id,
            window_start,
        )

        congestion_score = calculate_congestion_score(
            metrics["median_travel_time_seconds"],
            baseline_travel_time,
        )

        significant_change = (
            __import__(
                "workers.analytics.metrics",
                fromlist=["is_significant_change"],
            ).is_significant_change(
                congestion_score,
                metrics["vehicle_count"],
                baseline_vehicle_count,
            )
        )

        insert_traffic_metric(
            conn,
            camera_link_id,
            window_start,
            metrics["vehicle_count"],
            metrics["unique_vehicle_count"],
            metrics["median_travel_time_seconds"],
            baseline_travel_time,
            baseline_vehicle_count,
            congestion_score,
            metrics["travel_time_sample_count"],
            significant_change,
        )

    conn.commit()

    print(
        f"Completed analytics window "
        f"{window_start}"
    )


def main():
    print("Starting analytics worker...")

    conn = get_connection()

    print("PostgreSQL connection successful")

    try:
        while True:

            latest_completed = get_latest_completed_window()

            latest_processed = get_latest_processed_window(
                conn
            )

            # First ever run.
            if latest_processed is None:
                # Start with the most recent completed window.
                next_window = latest_completed

            else:
                next_window = (
                    latest_processed
                    + timedelta(minutes=5)
                )

            # Nothing new to process yet.
            if next_window > latest_completed:
                time.sleep(POLL_INTERVAL_SECONDS)
                continue

            # Process every missed window.
            while next_window <= latest_completed:

                try:
                    process_window(
                        conn,
                        next_window,
                    )

                except Exception as exc:
                    conn.rollback()

                    print(
                        f"[RETRY] analytics window "
                        f"{next_window} failed: {exc}"
                    )

                    # Don't advance the window.
                    # Retry it on the next polling cycle.
                    break

                next_window += timedelta(minutes=5)

            time.sleep(POLL_INTERVAL_SECONDS)

    finally:
        conn.close()


if __name__ == "__main__":
    main()