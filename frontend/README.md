# ANPR Control — GIS operations dashboard (Lane D)

React + TypeScript + Leaflet front end for the City-Wide ANPR Platform: camera
network map, plate trajectory reconstruction and replay, live blacklist and
route-anomaly alerts, macro traffic analytics, and weekly/monthly congestion
reporting.

> **The camera network is simulated.** Twelve fictional cameras placed on real road
> geometry in central Bengaluru, fed by generated observations. Every screen that
> shows camera positions, plate movements or traffic figures says so on the page —
> that labelling is deliberate and should not be removed.

## Quickstart

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

No backend required. The app defaults to `VITE_USE_MOCK=true`, which serves an
in-browser mock API and a simulated live feed from generated fixtures.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Type-check, then production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check:fixtures` | Asserts the generated dataset holds its invariants |
| `npm run check:api` | Exercises every mock endpoint and the trajectory rules |
| `npm run check:render` | Renders every route in jsdom and asserts the output |
| `npm run verify` | All of the above, then the build |

`npm run verify` is the gate to run before pushing.

## Switching to the real API

```bash
cp .env.example .env.local
# then set:
VITE_USE_MOCK=false
VITE_API_BASE_URL=/api
VITE_WS_URL=/ws/live
VITE_PROXY_TARGET=http://localhost:8000
```

Nothing else changes. Components call `apiClient` and `createLiveConnection` and
never learn which transport answered. The dev server proxies `/api` and `/ws` to
`VITE_PROXY_TARGET`, so there is no CORS work in development.

The mock is code-split behind a dynamic import, so with `VITE_USE_MOCK=false` the
fixture layer is not downloaded at all.

**The expected request/response shapes are in [`API_CONTRACT.md`](./API_CONTRACT.md).**
That document is the frontend's half of the contract with Lane B; if a shape
changes, change it there and in `src/types/api.ts` together.

## Layout

```
src/
  api/            transport layer
    client.ts       ApiClient interface + real HTTP impl + which one is active
    hooks.ts        React Query bindings — components use these, not apiClient
    live.ts         WebSocket with backoff, or the simulated emitter
    config.ts       the VITE_USE_MOCK switch and map defaults
    operator.ts     operator identity (placeholder for auth — see below)
    mock/
      queries.ts    the query engine: trajectory rules, aggregation, filtering
      transport.ts  ApiClient over the query engine, with simulated latency
      live.ts       simulated feed that mints real rows into the dataset
      seed/         the generated dataset (network, demand model, journeys, alerts)
  app/            shell: layout, sidebar, header, route table
  components/     design-system primitives + icons + the simulated-network notice
  features/
    map/            reusable Leaflet canvas and layers
    trajectory/     plate search, playback clock, route layer, evidence
    alerts/         dock, cards, filters, detail, acknowledgement
    analytics/      charts, O-D matrix, node and link tables
    reports/        day×hour heatmap, CSV export
    live/           the shared live-feed context
  lib/            geo, time, plate, congestion and RNG helpers
  pages/          one file per route
  types/          domain.ts mirrors db/schema.sql; api.ts holds the envelopes
```

## Decisions worth knowing

**Types mirror the schema.** `src/types/domain.ts` uses the SQL column names
verbatim (snake_case) so a row serialises straight to JSON with no rename layer.
CHECK-constrained columns become string-literal unions, so a status the UI has no
styling for is a compile error.

**A trajectory is many trips, not one route.** A commuter plate has ~40 accepted
sightings over four days. Treating those as one path made an overnight gap look
like a 20-hour traversal of a 1.4 km link and reported the average speed as
1.1 km/h. The timeline is split into segments on realistic gaps, and travel totals
exclude the gaps between them.

**`congestion_score` is measured against free flow**, not the window-of-week
baseline: `median_travel_time / free_flow_time_seconds`. Scoring against the
baseline gives ≈1.0 during a normal rush hour, which hides exactly what an operator
is looking for. `baseline_*` still drives `significant_change` and the report
deltas.

**Missing measurement is never drawn as a good result.** A link with no matched
journeys is grey, not green. An hour with no data in the report heatmap is hatched.
A faulty camera is drawn hollow and still listed with a zero rather than dropped.
Travel-time figures backed by fewer than five matched journeys are flagged.

**Withheld data is shown, not dropped.** Routes are built from `accepted` sightings
only, and the ones validation excluded are listed with their `validation_reason`, so
the gaps in a movement history are visible rather than silent.

**Both carriageways are drawn separately.** `camera_links` stores A→B and B→A as
two rows with mirrored geometry; drawn raw, one hides the other. Each direction is
offset onto its own side of the road and given a direction chevron.

## Two things the frontend had to assume

1. **There is no authentication.** `audit_logs.user_subject` is `NOT NULL`, so
   every sensitive action needs a subject. The client sends an
   `X-Operator-Subject` header and writes the same value to `acknowledged_by` /
   `added_by`. It is a locally-chosen name, shown in the header as *"acting as"*
   with a dashed border because it identifies without authenticating. When real
   auth lands, the server should take the subject from the token and ignore the
   header.

2. **Nothing sets `validation_status = 'accepted'` yet** (Lane C's validation
   step). Against live data the trajectory endpoint will return an empty route
   until it does. The UI already sends `include_unvalidated=true` and shows what
   was withheld, so the failure is legible rather than a blank screen.

## Verification

Four gates, all currently green:

- **`typecheck`** — strict, with `noUncheckedIndexedAccess` and no unused locals.
- **`check:fixtures`** — the dataset is generated, so it is asserted: unique
  `source_event_id`, accepted sightings always carry a resolved plate, schema
  shape guards on alerts hold, a faulty camera reports zero, every congestion
  bucket is reachable within 24 h.
- **`check:api`** — ~110 assertions over the query engine: trajectory ordering and
  hop classification, trip segmentation, pagination, filters, 404/409/422 paths,
  derived speed equals distance ÷ median travel time, report aggregation timing.
- **`check:render`** — renders all 12 route cases in jsdom against the mock and
  fails on any `console.error`. Asserts DOM, not just text: Leaflet built its
  layers, the heatmap is a full 7×24 grid, filter chips carry counts, the
  blacklist dialog is `aria-modal` and labelled. Includes interaction steps —
  pressing play advances the virtual clock *proportionally to the selected speed*,
  selecting an alert opens its detail, the dialog opens and closes.

**Known limitation:** verification is jsdom-based, not a real browser. It proves
the app mounts, Leaflet constructs its layers and playback runs at the right rate.
It does not check visual layout, so a human still needs to open `npm run dev` and
look at it.

## Accessibility

Keyboard focus is visible everywhere, the plate search implements the ARIA
combobox pattern (arrows, Enter, Escape, `aria-activedescendant`), tabs use a
roving tabindex, the modal traps focus and restores it on close, the playback
scrubber is a native range input, and status is conveyed by text as well as
colour. Full WCAG conformance would need manual testing with assistive
technologies and an expert review — this has not had either.

## Attribution

Basemap tiles are © [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors and © [CARTO](https://carto.com/attributions). The attribution
control is a licence condition — do not remove it.
