# Workers

Python worker processes that consume/produce around the `plate_sightings`
Redis Stream. Built later (implementation order steps 4–9). Each imports the
shared `anpr_common` package for the event contract and DB layer.

| Dir | Role |
|---|---|
| `ocr/` | YOLO plate/vehicle detection + PaddleOCR + multi-frame voting → publishes `PlateSighting` to Redis. Runs on prerecorded clips first, then RTSP. |
| `persistence/` | Consumes `PlateSighting`, resolves plate identity, upserts `sightings` into Postgres (idempotent on `source_event_id`). |
| `alerts/` | Blacklist match + route-anomaly detection (camera_links graph / travel-time feasibility) → writes `alerts`, pushes via WebSocket. |
| `analytics/` | 5-minute rollups → `camera_metrics_5m` (node) and `traffic_metrics_5m` (link). |
