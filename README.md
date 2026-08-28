# City-Wide ANPR Platform (SIH prototype)

Centralized AI platform over a city-wide ANPR camera network: high-accuracy
plate OCR, single-plate trajectory reconstruction on a GIS map, live
blacklist/anomaly alerts, and macro traffic-flow analytics.

> The demo camera network is **simulated** — fictional cameras placed on real
> roads over a small real corridor, fed by prerecorded clips and simulated
> observations.

## Repo layout

```
backend/    FastAPI API service (REST + WebSocket)
workers/    Python workers: ocr, persistence, alerts, analytics (built later)
common/     shared package `anpr_common` — PlateSighting contract + DB layer
frontend/   React + TypeScript + Leaflet dashboard (built later)
db/         schema.sql (full schema) + migrations/
docs/       contracts & design docs (e.g. plate_sighting_event.md)
data/       local sample clips / media (git-ignored blobs)
docker-compose.yml   infra: Postgres+PostGIS, Redis, MinIO, + API
```

## Architecture

```
Video/RTSP → OCR worker → Redis Stream (plate_sightings)
                              ├─ persistence → Postgres + PostGIS
                              ├─ alerts      → blacklist / route-anomaly + WebSocket
                              ├─ analytics   → 5-min metrics (camera + link)
                              └─ live publisher → WebSocket
                          FastAPI ⇄ React + Leaflet dashboard
Media (plate crops, clips) → MinIO/S3 (object keys stored on sightings)
```

## Configuration

Everything is URL-driven via `.env` (copy from `.env.example`). Swap to managed
services (Supabase / Upstash / any S3) by changing `DATABASE_URL`, `REDIS_URL`,
`S3_*` — no code or compose changes.

## Quickstart

```bash
cp .env.example .env
docker compose up -d --build      # Postgres+PostGIS, Redis, MinIO, API
curl localhost:8000/health        # {"status":"ok", ...}
```

The schema in `db/schema.sql` auto-applies to the local Postgres on first boot.
For a managed DB, apply it once manually.

## Implementation order

1. ✅ SQL schema (`db/schema.sql`)
2. ✅ `PlateSighting` event contract (`docs/plate_sighting_event.md`, `common/anpr_common/events.py`)
3. ✅ Docker Compose infra + API health endpoint
4. OCR worker on one prerecorded clip
5. Persist sightings
6. Plate lookup + Leaflet map
7. Blacklist alert + WebSocket
8. camera_links validation + anomaly alerts
9. 5-minute camera/link metrics + congestion overlays
