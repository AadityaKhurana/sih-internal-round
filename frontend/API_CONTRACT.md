# REST + WebSocket contract expected by the dashboard (Lane D → Lane B)

Lane D is built against the mock transport in `src/api/mock/`, which implements
every shape below. This document is a **proposal from the frontend**, not a
decision — Lane B owns the API. If a shape changes, change it here and in
`src/types/api.ts` together, and the components follow for free.

- Types: `src/types/domain.ts` (mirrors `db/schema.sql` column-for-column) and
  `src/types/api.ts` (per-endpoint envelopes).
- Field naming: **snake_case, identical to the SQL columns.** No rename layer.
- Timestamps: RFC 3339 with `Z`. Numerics: JSON numbers. UUIDs: strings.
- Coordinates: GeoJSON order `[lng, lat]`, SRID 4326.
- Base path: `/api`. WebSocket: `/ws/live`.

## Endpoints

| Method | Path | Query / Body | Response type |
|---|---|---|---|
| GET | `/cameras` | — | `CamerasResponse` (GeoJSON `FeatureCollection<Point, CameraProperties>`) |
| GET | `/camera-links` | — | `CameraLinksResponse` (GeoJSON `FeatureCollection<LineString, CameraLinkProperties>`) |
| GET | `/plates/search` | `q`, `limit` | `PlateSuggestion[]` |
| GET | `/plates/{plate}/trajectory` | `from`, `to`, `include_unvalidated` | `TrajectoryResponse` |
| GET | `/sightings` | `SightingsQuery` | `Paginated<Sighting>` |
| GET | `/alerts` | `AlertsQuery` | `Paginated<Alert>` |
| GET | `/alerts/counts` | `AlertsQuery` (minus paging) | `AlertCounts` |
| POST | `/alerts/{alert_id}/acknowledge` | `AcknowledgeAlertRequest` | `Alert` |
| GET | `/blacklist` | `BlacklistQuery` | `Paginated<BlacklistEntry>` |
| POST | `/blacklist` | `CreateBlacklistEntryRequest` | `BlacklistEntry` |
| PATCH | `/blacklist/{blacklist_entry_id}` | `UpdateBlacklistEntryRequest` | `BlacklistEntry` |
| GET | `/analytics/nodes` | `from`, `to` | `NodeMetricsResponse` |
| GET | `/analytics/links` | `from`, `to` | `LinkCongestionResponse` |
| GET | `/analytics/flow-trends` | `FlowTrendQuery` | `FlowTrendResponse` |
| GET | `/analytics/origin-destination` | `from`, `to` | `OriginDestinationResponse` |
| GET | `/analytics/reports/periods` | `granularity` | `ReportListResponse` |
| GET | `/analytics/reports` | `granularity`, `period` | `CongestionReport` |
| WS | `/ws/live` | — | stream of `LiveMessage` |

Array query params are repeated keys (`?status=new&status=delivered`), which is
what FastAPI produces for a `list[str]` dependency by default.

## Notes on the shapes that carry real logic

**Trajectory.** The endpoint returns `sightings` (accepted, time-ordered — the
route) *and* `excluded_sightings` (pending/uncertain/conflict, with
`validation_reason`). The UI shows what was withheld rather than silently
dropping it.

`segments[]` splits the timeline into **trips**. This matters more than it looks:
a commuter plate has ~40 accepted sightings over four days, and treating those as
one continuous path made a 20-hour overnight gap look like a single traversal of a
1.4 km link — which dragged the reported average speed down to 1 km/h and would
have invited an operator to read a journey that never happened. The cut rule the
client assumes:

- over a monitored link: a new trip when the gap exceeds
  `max(15 min, 6 × free_flow_time_seconds)`
- between unmonitored cameras: a new trip when the gap exceeds 30 min
- two sightings at the same camera within 5 min are one pass, not two

`total_duration_seconds` and `average_speed_kph` are computed across segments
only, so parked time is never counted as travel. `hops[]` is one entry per
consecutive pair *within* a segment — never across a trip break — each carrying a
`hop_status`:

| `hop_status` | Meaning | Rendered as |
|---|---|---|
| `valid` | link exists, travel time plausible | solid route line |
| `no_link` | no monitored link — unmonitored road used | dashed straight line |
| `impossible_travel_time` | faster than the link minimum | red line + warning |
| `wrong_direction` | heading contradicts `direction_label` | amber line + warning |

`path` on a hop is the `camera_links.path` geometry, so the map draws the real
road shape instead of a straight hop. Null for `no_link`.

**Derived speed** is never stored. Both `LinkCongestion.derived_speed_kph` and
`TrajectoryHop.implied_speed_kph` are `distance_meters / seconds → km/h`,
computed on read, matching the `traffic_metrics_5m` comment in the schema.

**`travel_time_sample_count`** is surfaced in the UI next to every congestion
figure. A link with 2 matched journeys is labelled low-confidence rather than
drawn as if it were solid. Please keep populating it.

**`congestion_score`** is expected as
`median_travel_time_seconds / camera_links.free_flow_time_seconds` — "how many
times slower than an empty road". 1.0 = free flow. The client buckets that ratio
into the colour ramp and does not recompute it, so the legend thresholds
(1.15 / 1.4 / 1.8 / 2.5) are keyed to this definition.

`baseline_travel_time_seconds` stays what the schema comment says — the typical
value for this window-of-week — and is used for `significant_change` and the
report deltas, *not* for the score. Scoring against free flow is what makes the
map readable: scoring against the window-of-week baseline gives ≈1.0 during a
normal rush hour, which hides the congestion an operator is looking for.

**Alert dedup.** `dedup_key` is `UNIQUE` in the schema but has no documented
format. The client treats it as an opaque idempotency key and dedupes
WebSocket-delivered alerts on it, so a redelivered alert does not appear twice.
Any stable format works.

**Acknowledgement** is a POST rather than a PATCH because it is an action with
audit consequences: it writes `acknowledged_at`/`acknowledged_by` *and* is
expected to append to `audit_logs`. `acknowledged_by` is sent explicitly from the
client's operator identity — see below.

## Two open items the frontend had to assume

1. **No auth yet.** `audit_logs.user_subject` is `NOT NULL`, so every sensitive
   read needs an identity. The client sends a header `X-Operator-Subject` on
   every request and also puts the value in `acknowledged_by` / `added_by`. It
   is currently a locally-chosen operator name (see the header menu), which is a
   placeholder, not authentication. When real auth lands, the server should take
   the subject from the token and ignore the header.

2. **Nothing sets `validation_status = 'accepted'` yet** (Lane C's validation
   step). Until then the trajectory endpoint will return an empty `sightings`
   array against live data. Interim suggestion: treat `accepted` as the filter
   but allow `?include_unvalidated=true` to fall back to `pending`, which the
   client already sends when the operator ticks "include unvalidated".

## WebSocket

Frames are JSON with a `type` discriminant: `hello` (once, carries
`schema_version`), `heartbeat`, `alert`, `sighting`, `alert_ack`. The client
reconnects with exponential backoff and refetches `/alerts` on reconnect to
close the gap, so dropped frames are not fatal. `sighting` frames use the
trimmed `LiveSighting` shape, not the full row.
