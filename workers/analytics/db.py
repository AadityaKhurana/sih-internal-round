from datetime import datetime, timezone

import psycopg

from .config import BASELINE_WEEKS


def get_connection():
    """
    Create a PostgreSQL connection.
    """
    from .config import DATABASE_URL

    return psycopg.connect(DATABASE_URL)


def get_cameras(conn):
    """
    Return all active cameras.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT camera_id
            FROM cameras
            WHERE status = 'active'
            """
        )

        return [row[0] for row in cur.fetchall()]


def get_camera_links(conn):
    """
    Return all active camera links and the information
    needed for link-level analytics.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                camera_link_id,
                from_camera_id,
                to_camera_id,
                distance_meters,
                free_flow_time_seconds
            FROM camera_links
            WHERE active = true
            """
        )

        return cur.fetchall()


def get_latest_processed_window(conn):
    """
    Find the most recent 5-minute window already processed.

    We use camera_metrics_5m as the processing checkpoint.
    """

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT MAX(window_start)
            FROM camera_metrics_5m
            """
        )

        return cur.fetchone()[0]


def insert_camera_metric(
    conn,
    camera_id,
    window_start,
    vehicle_count,
    unique_plate_count,
    significant_change,
):
    """
    Insert or update a camera-level 5-minute metric.
    """

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO camera_metrics_5m (
                camera_id,
                window_start,
                vehicle_count,
                unique_plate_count,
                significant_change
            )
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (camera_id, window_start)
            DO UPDATE SET
                vehicle_count = EXCLUDED.vehicle_count,
                unique_plate_count = EXCLUDED.unique_plate_count,
                significant_change = EXCLUDED.significant_change
            """,
            (
                camera_id,
                window_start,
                vehicle_count,
                unique_plate_count,
                significant_change,
            ),
        )


def insert_traffic_metric(
    conn,
    camera_link_id,
    window_start,
    vehicle_count,
    unique_vehicle_count,
    median_travel_time_seconds,
    baseline_travel_time_seconds,
    baseline_vehicle_count,
    congestion_score,
    travel_time_sample_count,
    significant_change,
):
    """
    Insert or update a link-level 5-minute metric.
    """

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO traffic_metrics_5m (
                camera_link_id,
                window_start,
                vehicle_count,
                unique_vehicle_count,
                median_travel_time_seconds,
                baseline_travel_time_seconds,
                baseline_vehicle_count,
                congestion_score,
                travel_time_sample_count,
                significant_change
            )
            VALUES (
                 %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
            ON CONFLICT (camera_link_id, window_start)
            DO UPDATE SET
                vehicle_count = EXCLUDED.vehicle_count,
                unique_vehicle_count = EXCLUDED.unique_vehicle_count,
                median_travel_time_seconds =
                    EXCLUDED.median_travel_time_seconds,
                baseline_travel_time_seconds =
                    EXCLUDED.baseline_travel_time_seconds,
                baseline_vehicle_count =
                    EXCLUDED.baseline_vehicle_count,
                congestion_score =
                    EXCLUDED.congestion_score,
                travel_time_sample_count =
                    EXCLUDED.travel_time_sample_count,
                significant_change =
                    EXCLUDED.significant_change
            """,
            (
                camera_link_id,
                window_start,
                vehicle_count,
                unique_vehicle_count,
                median_travel_time_seconds,
                baseline_travel_time_seconds,
                baseline_vehicle_count,
                congestion_score,
                travel_time_sample_count,
                significant_change,
            ),
        )


def get_baseline(conn, camera_link_id, window_start):
    """
    Calculate the historical baseline for the same
    day-of-week and 5-minute time slot.

    We look at the previous BASELINE_WEEKS weeks.

    Returns:
        (baseline_travel_time, baseline_vehicle_count)
    """

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                percentile_cont(0.5)
                    WITHIN GROUP (
                        ORDER BY median_travel_time_seconds
                    ) AS baseline_travel_time,
                percentile_cont(0.5)
                    WITHIN GROUP (
                        ORDER BY vehicle_count
                    ) AS baseline_vehicle_count
            FROM traffic_metrics_5m
            WHERE camera_link_id = %s

              AND window_start < %s

              AND window_start >=
                    %s - (%s * INTERVAL '7 days')

              AND EXTRACT(
                    ISODOW FROM window_start
                  ) = EXTRACT(
                    ISODOW FROM %s
                  )

              AND EXTRACT(
                    HOUR FROM window_start
                  ) = EXTRACT(
                    HOUR FROM %s
                  )

              AND EXTRACT(
                    MINUTE FROM window_start
                  ) = EXTRACT(
                    MINUTE FROM %s
                  )

              AND median_travel_time_seconds IS NOT NULL
            """,
            (
                camera_link_id,
                window_start,
                window_start,
                BASELINE_WEEKS,
                window_start,
                window_start,
                window_start,
            ),
        )

        row = cur.fetchone()

        if row is None:
            return None, None

        baseline_travel_time = (
            int(row[0])
            if row[0] is not None
            else None
        )

        baseline_vehicle_count = (
            int(row[1])
            if row[1] is not None
            else None
        )

        return baseline_travel_time, baseline_vehicle_count