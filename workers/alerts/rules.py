from __future__ import annotations

from datetime import timedelta


def blacklist_alert(
    conn,
    sighting,
):
    """
    Check whether the sighting's plate has an active blacklist entry.

    Returns:
        dict containing alert information, or None.
    """

    plate_id = sighting["plate_id"]

    if plate_id is None:
        return None

    entry = _get_blacklist_entry(
        conn,
        plate_id,
        sighting["spotted_at"],
    )

    if entry is None:
        return None

    return {
        "alert_type": "blacklist",
        "blacklist_entry_id": entry["blacklist_entry_id"],
        "match_confidence": _match_confidence(sighting),
        "dedup_key": f"blacklist:{sighting['sighting_id']}:{entry['blacklist_entry_id']}",
        "details": {
            "plate": sighting["normalized_plate"],
            "camera_code": sighting["camera_code"],
            "reason": entry["reason"],
            "severity": entry["severity"],
        },
    }


def route_anomaly_alert(
    conn,
    sighting,
    previous,
):
    """
    Detect route anomalies between two consecutive sightings.

    Rules:

    1. If the reverse direction exists but the observed direction
       does not, flag wrong_direction.

    2. If the directed link exists but observed travel time is
       shorter than free-flow travel time, flag
       impossible_travel_time.

    3. If neither direction is represented in camera_links, we do
       not automatically call it an anomaly. The cameras may simply
       be unconnected in the monitored graph.
    """

    if previous is None:
        return None

    if sighting["camera_id"] == previous["camera_id"]:
        return None

    from_camera_id = previous["camera_id"]
    to_camera_id = sighting["camera_id"]

    link = _get_camera_link(
        conn,
        from_camera_id,
        to_camera_id,
    )

    reverse_link = _get_camera_link(
        conn,
        to_camera_id,
        from_camera_id,
    )

    observed_seconds = (
        sighting["spotted_at"] - previous["spotted_at"]
    ).total_seconds()

    if observed_seconds <= 0:
        return None

    # ---------------------------------------------------------
    # WRONG DIRECTION
    # ---------------------------------------------------------

    if link is None and reverse_link is not None:
        return {
            "alert_type": "route_anomaly",
            "anomaly_reason": "wrong_direction",
            "previous_sighting_id": previous["sighting_id"],
            "match_confidence": 1.0,
            "dedup_key": (
                f"route:wrong_direction:"
                f"{previous['sighting_id']}:"
                f"{sighting['sighting_id']}"
            ),
            "details": {
                "from_camera": previous["camera_code"],
                "to_camera": sighting["camera_code"],
                "expected_direction": (
                    f"{reverse_link['from_camera_id']}"
                    f"->{reverse_link['to_camera_id']}"
                ),
                "observed_seconds": observed_seconds,
            },
        }

    # ---------------------------------------------------------
    # NO MONITORED LINK
    # ---------------------------------------------------------

    if link is None:
        return None

    # ---------------------------------------------------------
    # IMPOSSIBLE TRAVEL TIME
    # ---------------------------------------------------------

    free_flow_seconds = link["free_flow_time_seconds"]

    if free_flow_seconds is not None:
        if observed_seconds < free_flow_seconds:
            return {
                "alert_type": "route_anomaly",
                "anomaly_reason": "impossible_travel_time",
                "previous_sighting_id": previous["sighting_id"],
                "match_confidence": 1.0,
                "dedup_key": (
                    f"route:impossible_travel_time:"
                    f"{previous['sighting_id']}:"
                    f"{sighting['sighting_id']}"
                ),
                "details": {
                    "from_camera": previous["camera_code"],
                    "to_camera": sighting["camera_code"],
                    "observed_seconds": observed_seconds,
                    "free_flow_seconds": free_flow_seconds,
                    "distance_meters": link["distance_meters"],
                    "speed_limit_kph": link["speed_limit_kph"],
                },
            }

    return None


def _get_blacklist_entry(conn, plate_id, spotted_at):
    from .db import get_active_blacklist_entry

    row = get_active_blacklist_entry(
        conn,
        plate_id,
        spotted_at,
    )

    if row is None:
        return None

    return {
        "blacklist_entry_id": row["blacklist_entry_id"],
        "reason": row["reason"],
        "severity": row["severity"],
        "status": row["status"],
        "active_from": row["active_from"],
        "active_until": row["active_until"],
    }


def _get_camera_link(conn, from_camera_id, to_camera_id):
    from .db import get_camera_link

    row = get_camera_link(
        conn,
        from_camera_id,
        to_camera_id,
    )

    if row is None:
        return None

    return {
        "camera_link_id": row["camera_link_id"],
        "from_camera_id": row["from_camera_id"],
        "to_camera_id": row["to_camera_id"],
        "distance_meters": row["distance_meters"],
        "free_flow_time_seconds": row["free_flow_time_seconds"],
        "speed_limit_kph": row["speed_limit_kph"],
        "direction_label": row["direction_label"],
    }


def _match_confidence(sighting):
    """
    Use the available OCR/detection confidence as a useful alert
    confidence. We take the minimum available confidence so that
    weak OCR doesn't produce a falsely strong alert.
    """

    values = [
        sighting["detection_confidence"],
        sighting["ocr_confidence"],
    ]

    values = [
        float(value)
        for value in values
        if value is not None
    ]

    if not values:
        return None

    return min(values)