# Workers

Python worker processes around the `plate_sightings` Redis Stream. Each imports
the shared `anpr_common` package for the event contract and DB layer. All are
containerized (`workers/Dockerfile`) and wired into `docker-compose.yml`.

| Dir | Role |
|---|---|
| `ocr/` | **(Lane A)** YOLO vehicle + plate detection + PaddleOCR + multi-frame voting → publishes `PlateSighting`. Needs GPU / model weights / video; in the demo the synthetic **producer** stands in at the same event boundary. |
| `producer/` | Synthetic OCR stand-in. A fleet of plates drive **realistic corridor trips** across adjacent junctions, emitting `PlateSighting` events at per-approach cameras. Consecutive sightings of a plate are spaced by the connecting link's real free-flow time, so live impossible-travel alerts stay clean; the blacklisted plate walks continuously to exercise blacklist alerts. |
| `persistence/` | Consumes `PlateSighting`, resolves plate identity, **aggregates each camera up to its junction**, upserts `sightings` into Postgres (idempotent on `source_event_id`), and publishes `sightings:new`. |
| `alerts/` | Blacklist match + route-anomaly detection (camera_links graph / travel-time feasibility) → writes `alerts` and publishes `alerts:new` for the WebSocket. |
| `analytics/` | 5-minute rollups → `camera_metrics_5m` (node) and `traffic_metrics_5m` (link). |

The demo pipeline runs producer → persistence → alerts → analytics; swap the
producer for the OCR worker to feed real detections through the identical path.
