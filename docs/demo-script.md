# SIH 2026 — 5-Minute Demo Script
## MARG — Multi-camera ANPR & Route Graph (Dwarka, New Delhi prototype)

Target: ~5:00 spoken at ~150 wpm (~750 words). Time markers are cues, not hard cuts.
Each block has **[SAY]** (narration) and **[SHOW]** (on-screen action).

---

### PRE-DEMO CHECKLIST (do this before you present)
```
cd .../integration
docker compose up -d              # 9 services; dashboard :5173, API :8000
# load the genuine Dwarka network (stop workers first — seed TRUNCATEs):
docker compose stop producer persistence alerts analytics
docker compose exec -T postgres psql -U anpr -d anpr < db/seed_dwarka.sql
docker compose exec -T postgres psql -U anpr -d anpr < db/seed_metrics.sql
docker compose start producer persistence alerts analytics
```
Open http://localhost:5173 . Confirm: map shows junction circles + links, the
live ticker is moving, and `/health` is ok. Have plate **DL3CAB1234** (trajectory)
and **DL8CAF5678** (blacklisted) ready to type. Keep `docs/architecture.drawio` open in a tab.

---

### [0:00–0:40] The problem
**[SAY]** "Cities already run huge networks of CCTV and ANPR cameras — but they
work in silos. Each camera reads a plate and stops there. Nothing links those
reads across space and time. So authorities can't automatically follow a specific
vehicle across the city, and they can't turn all that footage into
macro traffic insight. The cameras exist; the *intelligence* on top of them
doesn't."
**[SHOW]** Title slide, or the live map already on screen.

### [0:40–1:20] Our solution
**[SAY]** "We built a centralized platform that sits on top of the existing camera
network and does three things. One — a high-accuracy ANPR/OCR engine, YOLO plus
PaddleOCR, that turns multi-lane video into structured plate events, targeting
90-plus-percent accuracy across bad lighting, weather, angle and motion blur. Two —
single-plate trajectory tracking: type any plate and we reconstruct its full path
across the city on a GIS map, with timestamps and direction. Three — macro traffic
analytics: density heatmaps, congestion bottlenecks, and origin-destination
patterns — plus a real-time alert system for blacklisted vehicles and route
anomalies."
**[SHOW]** Gesture at the four dashboard tabs (map, trajectory, alerts, analytics).

### [1:20–2:05] Architecture
**[SAY]** "Everything integrates at one clean boundary — a `PlateSighting` event.
Cameras publish sightings onto a Redis stream. Three workers consume it:
persistence validates and stores each sighting in PostgreSQL with PostGIS, and
crucially aggregates per-approach cameras up to junctions; an alerts worker runs
blacklist and travel-time-feasibility checks; an analytics worker rolls five-minute
metrics. A FastAPI backend serves the REST API and pushes live updates over
WebSocket to a React and Leaflet dashboard. Because the OCR engine is just one
producer on that event boundary, our live demo swaps it for a synthetic feed that
drives real traffic patterns — the rest of the system can't tell the difference."
**[SHOW]** `architecture.drawio` — trace top-to-bottom: cameras → Redis → workers →
Postgres → API → dashboard.

### [2:05–4:20] Live demo
**[SAY]** "This is a genuine Dwarka network — junctions on real roads, links routed
along the actual road network. Watch the ticker: live plate sightings are flowing
in right now."
**[SHOW]** The map. Point at moving sightings / the live feed indicator.

**(a) Trajectory — the headline feature.**
**[SAY]** "Say we're looking for one vehicle. I search its plate…"
**[SHOW]** Trajectory tab → type **DL3CAB1234** → select it.
**[SAY]** "…and the platform reconstructs its complete route across the city —
junction by junction, in chronological order, with the timestamp and direction at
each point, drawn on the map. That's the cross-space-and-time link that siloed
cameras can't give you."
**[SHOW]** The plotted path + the hop/timeline list.

**(b) Real-time alerts.**
**[SAY]** "Enforcement runs continuously. This plate is on the blacklist — the
moment a camera sees it, an alert fires in real time."
**[SHOW]** Alerts dock → open the **blacklist** alert for **DL8CAF5678** → show
camera, time, match. Mention the route-anomaly (impossible-travel) alert type too.

**(c) Macro analytics.**
**[SAY]** "Aggregate the same data and you get city-level intelligence — a density
heatmap across junctions, the most congested links by travel-time versus free-flow,
origin-destination flows, and trend charts."
**[SHOW]** Analytics tab → heatmap → link-congestion table → O-D / flow trends →
(optional) the reports day×hour heatmap.

### [4:20–5:00] Close
**[SAY]** "Under the hood it's production-shaped: fully containerized, URL-driven
config so Postgres, Redis and object storage swap to managed cloud services with no
code change, and the analytics path is scale-to-zero. The real OCR engine drops
into the exact same event boundary for a field deployment. So from the cameras a
city already owns, we deliver vehicle tracking, live enforcement, and traffic
analytics — one integrated platform. Thank you."
**[SHOW]** Back to the full map, or the architecture diagram.

---

### FALLBACK (if the live feed stalls mid-demo)
The **seeded** data stands alone: DL3CAB1234's trajectory, both alerts, and all
analytics render from the database even with the producer stopped. If the ticker
freezes, say "the live feed is the demo producer; the platform state is in
PostgreSQL" and continue on the seeded trajectory/alerts/analytics — nothing depends
on the feed being live.

### HONESTY NOTES (for Q&A, not the script)
- OCR (>90%) is the design target of the YOLO+PaddleOCR engine (Lane A); it needs
  GPU + video + weights, so the *live* demo uses the synthetic producer at the
  `PlateSighting` boundary. Offer to show the OCR code / a recorded run if asked.
- The camera network is simulated but geographically genuine (real Dwarka roads);
  every screen labels it as simulated.
