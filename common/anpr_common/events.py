"""Canonical `plate_sightings` Redis Stream contract (v1).

Single source of truth: the OCR worker (producer) and every consumer
(persistence / alerts / analytics / live publisher) import these models so the
event shape can never drift between services. See docs/plate_sighting_event.md
for the full field reference and JSON Schema.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

STREAM_NAME = "plate_sightings"
DLQ_STREAM_NAME = "plate_sightings.dlq"
SCHEMA_VERSION = 1


class OcrCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plate: str
    confidence: float = Field(ge=0, le=1)


class SightingMedia(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plate_crop_object_key: str | None = None
    vehicle_image_object_key: str | None = None
    context_clip_object_key: str | None = None


class PlateSighting(BaseModel):
    """One vehicle pass at one camera, after multi-frame OCR voting."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = SCHEMA_VERSION
    event_id: str                         # -> sightings.source_event_id (idempotency)
    camera_code: str                      # resolve -> cameras.camera_id
    captured_at: datetime                 # -> spotted_at (UTC)
    raw_plate_text: str
    normalized_plate: str | None          # -> normalized_plate_candidate
    detection_confidence: float = Field(ge=0, le=1)
    ocr_confidence: float = Field(ge=0, le=1)
    ocr_candidates: list[OcrCandidate] = Field(default_factory=list)
    camera_track_id: str | None = None
    vehicle_type: str | None = None
    vehicle_color: str | None = None
    lane_number: int | None = Field(default=None, ge=0)
    direction_degrees: float | None = Field(default=None, ge=0, le=360)
    quality_flags: dict = Field(default_factory=dict)
    model_version: str
    media: SightingMedia | None = None
