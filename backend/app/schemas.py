"""API response schemas. Map endpoints return GeoJSON so Leaflet can consume
them directly."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel


class GeoFeature(BaseModel):
    type: Literal["Feature"] = "Feature"
    geometry: dict[str, Any] | None = None
    properties: dict[str, Any]


class GeoFeatureCollection(BaseModel):
    type: Literal["FeatureCollection"] = "FeatureCollection"
    features: list[GeoFeature]


class TrajectoryLeg(BaseModel):
    """A hop between two consecutive sightings, matched to a camera_link."""

    from_camera_code: str
    to_camera_code: str
    link_found: bool                       # was a monitored camera_link present?
    geometry: dict[str, Any] | None = None  # LineString of the link path
    distance_meters: int | None = None
    free_flow_seconds: int | None = None
    observed_seconds: float                 # actual gap between the two sightings
    feasible: bool | None = None            # heuristic; None when no link to judge against


class TrajectoryResponse(BaseModel):
    plate: str
    plate_id: str
    sighting_count: int
    points: GeoFeatureCollection            # each sighting as a Point feature, time-ordered
    legs: list[TrajectoryLeg]


class AlertSightingRef(BaseModel):
    sighting_id: str
    camera_code: str | None = None
    display_name: str | None = None
    spotted_at: datetime | None = None


class AlertOut(BaseModel):
    alert_id: str
    alert_type: str                          # blacklist | route_anomaly
    status: str                              # new | delivered | acknowledged | resolved
    anomaly_reason: str | None = None
    match_confidence: float | None = None
    dedup_key: str
    plate: str | None = None
    severity: str | None = None              # from the blacklist entry, if any
    blacklist_reason: str | None = None
    details: dict[str, Any] = {}
    created_at: datetime
    delivered_at: datetime | None = None
    acknowledged_at: datetime | None = None
    acknowledged_by: str | None = None
    resolution_notes: str | None = None
    sighting: AlertSightingRef
    previous_sighting: AlertSightingRef | None = None


class AcknowledgeRequest(BaseModel):
    acknowledged_by: str
    resolution_notes: str | None = None


class CameraMetricWindow(BaseModel):
    window_start: datetime
    vehicle_count: int
    unique_plate_count: int
    significant_change: bool


class LinkMetricWindow(BaseModel):
    window_start: datetime
    vehicle_count: int
    unique_vehicle_count: int
    median_travel_time_seconds: int | None = None
    baseline_travel_time_seconds: int | None = None
    congestion_score: float | None = None
    est_speed_kph: float | None = None
    travel_time_sample_count: int
    significant_change: bool


class AnalyticsSummary(BaseModel):
    from_ts: datetime
    to_ts: datetime
    total_vehicle_passes: int
    total_unique_plates: int
    busiest_camera: dict[str, Any] | None = None
    most_congested_link: dict[str, Any] | None = None
