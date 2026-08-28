# `PlateSighting` Event Contract

The single message the **OCR worker** publishes to the Redis Stream
`plate_sightings`. Every downstream consumer (persistence, alert, analytics,
live-publisher) reads this exact shape. Treat it as a versioned contract: add
fields additively, never repurpose an existing field.

- **Stream:** `plate_sightings`
- **Producer:** Python OCR worker (one message per vehicle pass, *after*
  multi-frame voting)
- **Consumers:** persistence → Postgres/PostGIS, alert worker, analytics worker,
  live WebSocket publisher
- **Idempotency key:** `event_id` (maps to `sightings.source_event_id`, which is
  `UNIQUE`). Consumers MUST upsert/skip on duplicate `event_id` so redeliveries
  are safe.

## Example

```json
{
  "schema_version": 1,
  "event_id": "cam12-track834-20260828T103142",
  "camera_code": "CAM-12",
  "captured_at": "2026-08-28T10:31:42Z",
  "raw_plate_text": "DL01A81234",
  "normalized_plate": "DL01AB1234",
  "detection_confidence": 0.96,
  "ocr_confidence": 0.91,
  "ocr_candidates": [
    { "plate": "DL01AB1234", "confidence": 0.91 },
    { "plate": "DL01A81234", "confidence": 0.76 }
  ],
  "camera_track_id": "track-834",
  "vehicle_type": "car",
  "vehicle_color": "white",
  "lane_number": 2,
  "direction_degrees": 180,
  "quality_flags": { "night": false, "motion_blur": true, "angled": false },
  "model_version": "anpr-v1",
  "media": {
    "plate_crop_object_key": "crops/CAM-12/20260828/track834.jpg",
    "vehicle_image_object_key": "vehicles/CAM-12/20260828/track834.jpg",
    "context_clip_object_key": "clips/CAM-12/20260828/track834.mp4"
  }
}
```

## Field reference

| Field | Type | Req | Maps to `sightings` | Notes |
|---|---|:--:|---|---|
| `schema_version` | int | ✓ | — | Contract version. Start at `1`. |
| `event_id` | string | ✓ | `source_event_id` | Globally unique idempotency key. Convention: `<camera>-<track>-<UTC compact ts>`. |
| `camera_code` | string | ✓ | → resolve to `camera_id` | Business code, not the UUID. Persistence looks up `cameras.camera_code`. Unknown code ⇒ dead-letter. |
| `captured_at` | string (RFC 3339 UTC) | ✓ | `spotted_at` | When the vehicle passed. Always UTC (`Z`). |
| `raw_plate_text` | string | ✓ | `raw_plate_text` | Best raw OCR string before normalization. |
| `normalized_plate` | string \| null | ✓ | `normalized_plate_candidate` → resolve `plate_id` | Null when OCR could not produce a confident candidate. |
| `detection_confidence` | number 0–1 | ✓ | `detection_confidence` | Vehicle/plate detector score. |
| `ocr_confidence` | number 0–1 | ✓ | `ocr_confidence` | Voted OCR score for the chosen candidate. |
| `ocr_candidates` | array | ✓ | `ocr_candidates` (jsonb) | `[{plate, confidence}]`, descending confidence. May be `[]`. |
| `camera_track_id` | string \| null | ✕ | `camera_track_id` | Tracker id within the camera stream. |
| `vehicle_type` | string \| null | ✕ | `vehicle_type` | `car`, `truck`, `bus`, `two_wheeler`, … |
| `vehicle_color` | string \| null | ✕ | `vehicle_color` | |
| `lane_number` | int \| null | ✕ | `lane_number` | |
| `direction_degrees` | number 0–360 \| null | ✕ | `direction_degrees` | Vehicle heading; used for `wrong_direction` anomaly. |
| `quality_flags` | object | ✕ | `quality_flags` (jsonb) | Free-form booleans: `night`, `motion_blur`, `angled`, `occluded`, `dirty_plate`, … |
| `model_version` | string | ✓ | `model_version` | Detector+OCR bundle version for traceability. |
| `media` | object \| null | ✕ | `*_object_key` | MinIO/S3 keys only — never inline binary. |

### Consumer responsibilities (not carried in the event)

These are set by the **persistence worker**, not the OCR worker:

- `sighting_id` — generated on insert.
- `plate_id` — resolved/created from `normalized_plate` (null stays null).
- `processed_at` — `now()` at insert time.
- `validation_status` / `validation_reason` — start `pending`; the alert/
  validation step advances to `accepted` / `uncertain` / `conflict`.

## JSON Schema (draft 2020-12)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://sih-anpr/events/plate_sighting/v1.json",
  "title": "PlateSighting",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version", "event_id", "camera_code", "captured_at",
    "raw_plate_text", "normalized_plate", "detection_confidence",
    "ocr_confidence", "ocr_candidates", "model_version"
  ],
  "properties": {
    "schema_version": { "type": "integer", "const": 1 },
    "event_id": { "type": "string", "minLength": 1 },
    "camera_code": { "type": "string", "minLength": 1 },
    "captured_at": { "type": "string", "format": "date-time" },
    "raw_plate_text": { "type": "string" },
    "normalized_plate": { "type": ["string", "null"] },
    "detection_confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "ocr_confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "ocr_candidates": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["plate", "confidence"],
        "properties": {
          "plate": { "type": "string" },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
        }
      }
    },
    "camera_track_id": { "type": ["string", "null"] },
    "vehicle_type": { "type": ["string", "null"] },
    "vehicle_color": { "type": ["string", "null"] },
    "lane_number": { "type": ["integer", "null"], "minimum": 0 },
    "direction_degrees": { "type": ["number", "null"], "minimum": 0, "maximum": 360 },
    "quality_flags": { "type": "object" },
    "model_version": { "type": "string", "minLength": 1 },
    "media": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "properties": {
        "plate_crop_object_key": { "type": ["string", "null"] },
        "vehicle_image_object_key": { "type": ["string", "null"] },
        "context_clip_object_key": { "type": ["string", "null"] }
      }
    }
  }
}
```

## Shared Pydantic model (producer + consumers import this)

> Canonical source: `common/anpr_common/events.py` (installable as `anpr_common`).
> The block below mirrors it — edit the module, not this doc.

```python
# common/anpr_common/events.py
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, ConfigDict


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
    """Contract for the `plate_sightings` Redis Stream. v1."""
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
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
```

### Publish / consume snippet

```python
# producer (OCR worker)
r.xadd("plate_sightings", {"data": sighting.model_dump_json()})

# consumer (persistence / alert / analytics)
for _id, fields in messages:
    sighting = PlateSighting.model_validate_json(fields["data"])
    # ... upsert on sighting.event_id (skip if already persisted)
```

## Versioning rules

- Bump `schema_version` only on a breaking change; add optional fields without a
  bump.
- Consumers reject an unknown `schema_version` to a dead-letter stream
  (`plate_sightings.dlq`) rather than guessing.
- Validation failures (`extra="forbid"` / schema violation) also dead-letter, so
  a malformed producer can't silently corrupt the sightings table.
