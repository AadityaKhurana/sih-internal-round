# City-Wide ANPR Platform (SIH prototype)

Centralized platform over a city-wide ANPR camera network: plate OCR,
single-plate trajectory reconstruction on a GIS map, live blacklist / route-anomaly
alerts, and macro traffic-flow analytics.

> **The demo network is simulated but geographically genuine.** Real junctions on
> real **Dwarka, New Delhi** roads. The map shows one circle per **junction**; the
> per-approach **cameras** that actually source the data live behind the scenes and
> are aggregated up to junctions. A synthetic producer stands in for the OCR lane,
> emitting the real `PlateSighting` contract as a fleet of plates drive realistic
> corridor trips. Real OCR (YOLO + PaddleOCR) needs GPU / weights / video and drops
> in at the same event boundary with no downstream changes.

## Repo layout

```
backend/    FastAPI API service (REST under /api + WebSocket /ws/live)
workers/    persistence, alerts, analytics + a synthetic producer; ocr/ is Lane A
common/     shared package `anpr_common` — PlateSighting contract + DB layer
frontend/   React + TypeScript + Leaflet operations dashboard
db/         schema.sql, seed_dwarka.sql (generated) + gen_dwarka_seed.py, seed_metrics.sql
docs/       contracts & design docs (e.g. plate_sighting_event.md)
data/       local sample clips / media (git-ignored blobs)
docker-compose.yml   full stack: Postgres+PostGIS, Redis, MinIO, API, workers, producer, frontend
```

## Architecture

```
cameras (one per approach) ─ PlateSighting ─▶ Redis Stream (plate_sightings)
                                              ├─ persistence → aggregate camera→junction,
                                              │                upsert Postgres+PostGIS, publish sightings:new
                                              ├─ alerts      → blacklist / route-anomaly → alerts:new
                                              ├─ analytics   → 5-min metrics (camera + link)
                                              └─ live publisher (inside API) → WebSocket /ws/live
                          FastAPI ⇄ React + Leaflet dashboard
Media (plate crops, clips) → MinIO/S3 (object keys stored on sightings)
```

Everything integrates at the **`PlateSighting`** event boundary: in the demo the
synthetic producer emits it; real OCR replaces the producer with no other change.

## Quickstart

```bash
cp .env.example .env
docker compose up -d --build          # full stack — API :8000, dashboard :5173
curl localhost:8000/health            # {"status":"ok", ...}

# Load the genuine Dwarka demo network. The seed TRUNCATEs the network tables,
# which needs an exclusive lock, so stop the workers holding those tables first:
docker compose stop producer persistence alerts analytics
docker compose exec -T postgres psql -U anpr -d anpr < db/seed_dwarka.sql
docker compose exec -T postgres psql -U anpr -d anpr < db/seed_metrics.sql
docker compose start producer persistence alerts analytics
```

Open the dashboard at http://localhost:5173. The schema in `db/schema.sql`
auto-applies to the local Postgres on first boot.

## The demo network

- **Junctions** are curated on real Dwarka roads and are the map's display nodes
  (one plain circle each). Add/remove them by coordinate or name in
  `db/gen_dwarka_seed.py`.
- **Junction-to-junction links** connect every direct (1-edge) road neighbour:
  a link exists only if the OSRM driving route passes no other junction and is
  reasonably direct (detour ≤ 1.9×), and routing is bearing-hinted so links follow
  the correct carriageway with no wrong-way U-turns.
- **Per-approach cameras** (one per real arm, on the incoming left carriageway a
  few metres before the junction, facing upstream — left-hand driving) persist in
  the `approach_cameras` table and are the real sighting sources; the backend
  aggregates their data up to junctions.
- **Regenerate** after editing junctions: `python3 db/gen_dwarka_seed.py` (needs
  network — it snaps and routes via OSRM), then re-apply the seed as above.

## Configuration

Everything is URL-driven via `.env` (copy from `.env.example`). Swap to managed
services (Supabase / Upstash / any S3) by changing `DATABASE_URL`, `REDIS_URL`,
`S3_*` — no code or compose changes. Auth is header-based
(`X-Operator-Subject`); `API_AUTH_TOKEN` is empty by default.

## Status

Schema, `PlateSighting` contract, Docker Compose infra, the persistence / alerts /
analytics workers, the synthetic corridor-trip producer, the FastAPI backend (full
frontend-contract parity), and the React + Leaflet dashboard are all in place and
run end-to-end. The real OCR worker (`workers/ocr/`, Lane A) is integrated at the
event boundary but is stubbed by the synthetic producer in this environment.
