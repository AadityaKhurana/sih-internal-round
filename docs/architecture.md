# System Architecture — City-Wide ANPR Platform

Rendered with [Mermaid](https://mermaid.js.org/) (GitHub/most viewers render it inline).

Everything integrates at the **`PlateSighting`** event boundary: the real OCR
worker (Lane A) and the demo producer are interchangeable there. Persistence
**aggregates per-approach cameras up to junction nodes**; the live path is Redis
pub/sub → the API's in-process WebSocket publisher → the dashboard.

```mermaid
flowchart TB
  subgraph EDGE["Edge / Ingest"]
    CAMS["Per-approach cameras<br/>(one per junction arm)"]
    OCR["OCR worker — Lane A<br/>YOLO + PaddleOCR + voting<br/>(needs GPU/weights/video)"]
    PROD["Producer — demo feed<br/>synthetic corridor trips"]
    CAMS --> OCR
    CAMS -. "stubbed in demo by" .-> PROD
  end

  subgraph BUS["Redis"]
    STREAM[["plate_sightings<br/>stream · consumer group + DLQ"]]
    CH1(["sightings:new · pub/sub"])
    CH2(["alerts:new · pub/sub"])
  end

  OCR -- PlateSighting --> STREAM
  PROD -- PlateSighting --> STREAM

  subgraph WORK["Workers (Python)"]
    PERS["persistence<br/>validate · camera→junction<br/>upsert sightings/plates"]
    ALRT["alerts<br/>blacklist + route-anomaly<br/>(travel-time feasibility)"]
    ANAL["analytics<br/>5-min camera/link rollups"]
  end

  STREAM --> PERS
  PERS -- sightings:new --> CH1
  PERS --> ALRT
  ALRT -- alerts:new --> CH2
  PERS --> ANAL

  subgraph STORE["Storage"]
    PG[("PostgreSQL + PostGIS<br/>cameras(junction nodes) · approach_cameras<br/>camera_links · roads · plates · sightings<br/>blacklist_entries · alerts · audit_logs<br/>camera_metrics_5m · traffic_metrics_5m")]
    S3[("MinIO / S3<br/>plate crops · clips")]
  end

  PERS --> PG
  ALRT --> PG
  ANAL --> PG
  OCR -. media keys .-> S3

  subgraph APP["FastAPI backend"]
    REST["REST /api<br/>cameras · camera-links · plates · trajectory<br/>sightings · alerts · blacklist · analytics · reports<br/>(auth: X-Operator-Subject)"]
    WSP["live publisher → WS /ws/live"]
  end

  PG --> REST
  CH1 --> WSP
  CH2 --> WSP

  subgraph FE["Frontend — React + TS + Leaflet"]
    UI["map · trajectory · alerts<br/>analytics · reports · blacklist · live"]
  end

  REST -->|"/api (Vite proxy)"| UI
  WSP -->|"/ws/live"| UI

  CONTRACT["anpr_common<br/>PlateSighting contract + DB layer"]
  CONTRACT -. shared .-> OCR
  CONTRACT -. shared .-> PROD
  CONTRACT -. shared .-> PERS

  S3 -. presigned media .-> UI
```

## Runtime seams

| From | Via | To | Payload |
|---|---|---|---|
| OCR / Producer | Redis stream `plate_sightings` | persistence | `PlateSighting` (anpr_common) |
| persistence | Postgres | — | upsert `sightings` (idempotent on `source_event_id`), resolve plate, camera→junction |
| persistence | Redis `sightings:new` | API live publisher | new sighting id |
| persistence → alerts | (stream/derived) | alerts | accepted sightings |
| alerts | Redis `alerts:new` | API live publisher | new alert |
| analytics | Postgres | — | `camera_metrics_5m`, `traffic_metrics_5m` |
| API | REST `/api` + WS `/ws/live` | frontend | contract shapes in `src/types/api.ts` |

## Display model

The **map shows junctions** (the `cameras` table holds junction nodes with NULL
heading → plain circles) and **junction-to-junction links** (each junction to
every 1-edge road neighbour; a link exists only where the OSRM route passes no
other junction and is reasonably direct, bearing-hinted to avoid U-turns). The
real **per-approach cameras** live in `approach_cameras` (one per arm, on the
incoming left carriageway, facing upstream) and are the sighting data sources;
the backend aggregates their data up to junctions.

## Deployment (Docker Compose)

`postgres` (PostGIS) · `redis` · `minio` (+`minio-init`) · `api` (:8000) ·
`persistence` · `alerts` · `analytics` · `producer` · `frontend` (:5173). All
URL-driven via `.env`; swap to managed Postgres/Redis/S3 with no code changes.
