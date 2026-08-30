# Work Breakdown — City-Wide ANPR Platform

Remaining work organized into parallel lanes for team division. The two contracts
that make lanes independent are already fixed: the **DB schema** (`db/schema.sql`)
and the **`PlateSighting` event** (`common/anpr_common/events.py`). Lanes only
interact through those two interfaces.

## Done (baseline)

- Repo structure (`backend/ workers/ common/ frontend/ db/ docs/ data/`)
- SQL schema — `db/schema.sql` (10 tables, PostGIS, indexes)
- `PlateSighting` event contract — `docs/plate_sighting_event.md` + `common/anpr_common/events.py`
- Infra via Docker Compose — Postgres+PostGIS, Redis, MinIO, API (booted + verified)
- API `/health` endpoint (checks Postgres+PostGIS+Redis)

---

## Lane A — OCR / Computer Vision (`workers/ocr/`)

Owner: strongest in CV/Python. **Goal: >90% plate accuracy.**

- [ ] Collect/prepare prerecorded clips for the corridor → `data/`
- [ ] YOLO vehicle + plate detection
- [ ] PaddleOCR plate reading on detected plates
- [ ] Per-vehicle tracking + multi-frame voting → one best plate per pass (`camera_track_id`)
- [ ] Plate normalization (Indian format) → put in `common/` so persistence reuses it
- [ ] Quality flags (blur / night / angled) + confidence thresholds
- [ ] Write crop / vehicle image / clip to MinIO; publish `PlateSighting` to Redis
- [ ] Accuracy eval harness (labeled set, per-char + full-plate accuracy) to prove >90%
- [ ] (Later) RTSP live ingest

## Lane B — Backend API (`backend/app/`)

Owner: FastAPI/SQL. **Note: API currently has no auth — decide before demo.**

- [ ] Shared DB layer in `common/` (async pool + query helpers) — *prerequisite for Lanes B & C, build first*
- [ ] `GET /cameras`, `/camera-links` (GeoJSON for the map)
- [ ] **Plate trajectory endpoint**: accepted sightings → time-ordered → validated against `camera_links` → link paths + timestamps/direction (core query)
- [ ] Alerts endpoints: list/filter + acknowledge (writes `acknowledged_*`)
- [ ] Analytics endpoints: node metrics, link congestion, flow trends, derived speed, weekly/monthly reports
- [ ] WebSocket endpoint for live alerts + live sightings
- [ ] Audit logging on sensitive reads (trajectory / owner / evidence views → `audit_logs`)

## Lane C — Pipeline workers (`workers/persistence`, `alerts`, `analytics`)

Owner: backend/data. Splittable into 2 (persistence+alerts / analytics).

- [ ] **Persistence**: consume stream, resolve-or-create `plate`, idempotent upsert into `sightings` (on `source_event_id`), DLQ on bad/unknown-schema events
- [ ] **Validation**: mark sightings `accepted / uncertain / conflict`
- [ ] **Alerts**: blacklist match → blacklist alert; route-anomaly (camera_links graph + free-flow/min travel time → `impossible_travel_time`, `wrong_direction`, `suspected_clone`) → route_anomaly alert; `dedup_key`; push over WebSocket. Anomaly logic independent of blacklist
- [ ] **Analytics**: 5-min tumbling windows → `camera_metrics_5m` (node) + `traffic_metrics_5m` (link); match journeys at both link ends for travel time; `congestion_score`, baseline, `significant_change`

## Lane D — Frontend / GIS dashboard (`frontend/`)

Owner: React/TS. Can start immediately against fixtures/mock API.

- [ ] Vite + TS + Leaflet scaffold + design system
- [ ] Map with simulated camera markers + links (clearly labeled "simulated demo network")
- [ ] Plate search → chronological trajectory playback (timestamps, direction, route)
- [ ] Live alerts panel (WebSocket): blacklist + anomaly
- [ ] Traffic dashboard: node heatmap, link congestion overlay, flow trends, O-D patterns, derived speeds
- [ ] Weekly/monthly congestion reports
- [ ] Blacklist management + alert acknowledgement UI

## Lane E — Demo data, DevOps, integration (`db/`, `docker-compose.yml`, docs)

Owner: whoever integrates. Unblocks B, C, D early.

- [ ] **Seed script**: `roads`, `cameras` (real corridor coords), `camera_links` (path geometry, distance, free-flow time) — *high priority, everything downstream needs it*
- [ ] Simulated observation generator (demo without running heavy OCR)
- [ ] Curated blacklist entries + a scripted "impossible travel" scenario to trigger an anomaly on cue
- [ ] Add worker services to compose once they exist; wire external providers (Supabase/Upstash) via `.env`
- [ ] Reset/seed scripts + Makefile; end-to-end demo runbook; integration tests; accuracy report

---

## Critical path / sequencing

1. **Seed data (E)** and **common DB layer (B)** first — they unblock the most.
2. OCR (A) and persistence (C) run in parallel off the event contract immediately.
3. Alerts (C) needs persistence + seed camera_links + blacklist.
4. Analytics (C) needs sightings flowing.
5. Frontend (D) starts now on fixtures, swaps to real API as endpoints land.

**Suggested split (4–5 people):** A=1 (CV), B=1 (API+DB layer), C=1–2 (workers),
D=1 (frontend); E shared/rotated. With exactly 4, fold E into B.
