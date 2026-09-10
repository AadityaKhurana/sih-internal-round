/**
 * Analytic traffic-demand model behind the mock analytics endpoints.
 *
 * Rather than materialising ~70 days × 288 windows × 38 series of metric rows,
 * every metric is a pure function of (series, window start). Querying a range
 * evaluates only the windows asked for, and the answer is identical on every
 * call — so a reload does not reshuffle the charts.
 *
 * The model composes four factors:
 *   1. a per-camera volume weight (arterials carry more than side roads),
 *   2. a diurnal curve with AM and PM peaks,
 *   3. a day-of-week multiplier (weekends damped),
 *   4. deterministic per-window noise, plus scripted incidents.
 *
 * Congestion convention (also in frontend/API_CONTRACT.md):
 *   congestion_score = median_travel_time / free_flow_time_seconds
 * i.e. "how many times slower than an empty road". `baseline_travel_time_seconds`
 * stays what the schema says it is — the typical value for this window-of-week —
 * and is used for `significant_change` and the report deltas.
 */

import { hashUnit } from '@/lib/rng';
import { DAY_MS, HOUR_MS, isoDayOfWeek, startOfDay } from '@/lib/time';
import { cameraByCode, findLink, outgoingLinks, roads } from './network';
import { DATASET_NOW } from './clock';

/**
 * road_id → road_code. `camera_links` carries the uuid, while the sensitivity
 * table below is keyed by the human-readable code.
 */
const ROAD_CODE_BY_ROAD_ID = new Map(
  roads.map((road) => [road.road_id, road.road_code]),
);

/* ------------------------------------------------------------- base curves -- */

/** Vehicles per 5 minutes at the absolute peak, per camera. */
const CAMERA_PEAK_VOLUME: Record<string, number> = {
  'CAM-01': 210,
  'CAM-02': 185,
  'CAM-03': 175,
  'CAM-04': 150,
  'CAM-05': 120,
  'CAM-06': 95,
  'CAM-07': 165,
  'CAM-08': 130,
  'CAM-09': 110,
  'CAM-10': 125,
  'CAM-11': 195,
  'CAM-12': 205,
};

/**
 * How much a corridor's travel time inflates under load. Brigade Road chokes
 * long before Kasturba Road does.
 */
const ROAD_SENSITIVITY: Record<string, number> = {
  'BRG-RD-1': 1.55,
  'MG-RD-C1': 1.25,
  'RES-RD-1': 1.15,
  'OMR-SEG-1': 1.05,
  'IND-100FT': 1.0,
  'ARP-RD-1': 0.95,
  'HAL-RD-1': 0.85,
  'KST-CUB-1': 0.7,
};

const DAY_MULTIPLIER = [0.98, 1.0, 1.02, 1.04, 1.09, 0.82, 0.58] as const;

function bell(x: number, centre: number, width: number): number {
  const d = (x - centre) / width;
  return Math.exp(-0.5 * d * d);
}

/**
 * Fraction of peak demand at a given hour-of-day (0–24, fractional).
 * Twin commuter peaks, a midday plateau, and a genuine overnight trough.
 */
function diurnal(hourOfDay: number): number {
  const raw =
    0.06 +
    0.86 * bell(hourOfDay, 9.4, 1.35) +
    1.0 * bell(hourOfDay, 18.7, 1.65) +
    0.44 * bell(hourOfDay, 13.5, 2.6) +
    0.16 * bell(hourOfDay, 22.5, 1.8) +
    0.05 * bell(hourOfDay, 3.0, 2.0);
  return Math.min(1, raw / 1.06);
}

/**
 * Combined load factor in roughly 0.05–1.0 for a window start. Exported as
 * `demandWeight` so the journey generator can bias start times towards peaks
 * and stay consistent with the aggregate metrics.
 */
function loadFactor(windowStartMs: number): number {
  const date = new Date(windowStartMs);
  const hourOfDay = date.getHours() + date.getMinutes() / 60;
  const dow = isoDayOfWeek(date);
  return diurnal(hourOfDay) * (DAY_MULTIPLIER[dow] ?? 1);
}

export function demandWeight(atMs: number): number {
  return loadFactor(atMs);
}

/** Deterministic multiplicative noise centred on 1. */
function noise(spread: number, ...key: Array<string | number>): number {
  return 1 + (hashUnit(...key) - 0.5) * 2 * spread;
}

/* ------------------------------------------------------------ camera health -- */

/**
 * Share of passing vehicles a camera actually records. A `fault` camera
 * contributes nothing — which is exactly what the dashboard should show, rather
 * than quietly interpolating over the gap.
 */
export function captureRate(cameraCode: string): number {
  const status = cameraByCode.get(cameraCode)?.properties.status ?? 'active';
  switch (status) {
    case 'active':
      return 1;
    case 'maintenance':
      return 0.45;
    case 'inactive':
    case 'fault':
      return 0;
    default:
      return 1;
  }
}

/* ---------------------------------------------------------------- incidents -- */

export interface Incident {
  incident_id: string;
  label: string;
  /** Directed link keys, `FROM->TO`. */
  link_keys: readonly string[];
  start_ms: number;
  end_ms: number;
  /** Extra congestion ratio added at the incident's midpoint. */
  peak_extra_ratio: number;
}

function localTimeOn(daysAgo: number, hours: number, minutes: number): number {
  return startOfDay(DATASET_NOW - daysAgo * DAY_MS).getTime() + hours * HOUR_MS + minutes * 60_000;
}

/**
 * Scripted congestion events. Two straddle "now" so the default map view always
 * has something worth looking at, whatever time the demo runs; the rest sit in
 * history so the trend charts and weekly report have visible structure.
 */
export const incidents: readonly Incident[] = [
  {
    incident_id: 'INC-LIVE-MG',
    label: 'MG Road westbound — signal failure at Anil Kumble Circle',
    link_keys: ['CAM-01->CAM-02', 'CAM-02->CAM-03'],
    start_ms: DATASET_NOW - 35 * 60_000,
    end_ms: DATASET_NOW + 40 * 60_000,
    peak_extra_ratio: 1.3,
  },
  {
    incident_id: 'INC-LIVE-RES',
    label: 'Residency Road — lane closure for utility work',
    link_keys: ['CAM-08->CAM-07'],
    start_ms: DATASET_NOW - 20 * 60_000,
    end_ms: DATASET_NOW + 55 * 60_000,
    peak_extra_ratio: 0.75,
  },
  {
    incident_id: 'INC-D1-OMR',
    label: 'Old Madras Road — waterlogging at the CMH junction',
    link_keys: ['CAM-11->CAM-01'],
    start_ms: localTimeOn(1, 17, 45),
    end_ms: localTimeOn(1, 19, 15),
    peak_extra_ratio: 1.45,
  },
  {
    incident_id: 'INC-D3-ARP',
    label: 'Airport Road — vehicle breakdown before Domlur flyover',
    link_keys: ['CAM-01->CAM-12', 'CAM-12->CAM-11'],
    start_ms: localTimeOn(3, 8, 40),
    end_ms: localTimeOn(3, 10, 10),
    peak_extra_ratio: 1.15,
  },
  {
    incident_id: 'INC-D6-BRG',
    label: 'Brigade Road — event closure',
    link_keys: ['CAM-02->CAM-08', 'CAM-08->CAM-07'],
    start_ms: localTimeOn(6, 19, 0),
    end_ms: localTimeOn(6, 21, 30),
    peak_extra_ratio: 1.6,
  },
];

/** Triangular ramp: 0 at the edges, `peak_extra_ratio` in the middle. */
function incidentExtra(linkKey: string, windowStartMs: number): number {
  let extra = 0;
  for (const incident of incidents) {
    if (windowStartMs < incident.start_ms || windowStartMs >= incident.end_ms) continue;
    if (!incident.link_keys.includes(linkKey)) continue;
    const span = incident.end_ms - incident.start_ms;
    const progress = (windowStartMs - incident.start_ms) / span;
    const ramp = 1 - Math.abs(progress - 0.5) * 2;
    extra += incident.peak_extra_ratio * Math.max(0, ramp);
  }
  return extra;
}

export function activeIncidents(atMs: number = DATASET_NOW): Incident[] {
  return incidents.filter((i) => atMs >= i.start_ms && atMs < i.end_ms);
}

/* ----------------------------------------------------------- camera metrics -- */

export interface CameraWindowMetric {
  vehicle_count: number;
  unique_plate_count: number;
  baseline_vehicle_count: number;
  significant_change: boolean;
}

/** `camera_metrics_5m` for one camera and one window, computed on demand. */
export function cameraWindowMetric(
  cameraCode: string,
  windowStartMs: number,
): CameraWindowMetric {
  const peak = CAMERA_PEAK_VOLUME[cameraCode] ?? 100;
  const capture = captureRate(cameraCode);
  const load = loadFactor(windowStartMs);

  const baseline = Math.round(peak * load * capture);
  const observed = Math.round(baseline * noise(0.14, cameraCode, windowStartMs, 'vol'));
  const vehicleCount = Math.max(0, observed);

  // Repeat vehicles inside a 5-minute window are rare but not zero.
  const uniqueRatio = 0.93 + hashUnit(cameraCode, windowStartMs, 'uniq') * 0.06;

  const drift = baseline > 0 ? Math.abs(vehicleCount - baseline) / baseline : 0;

  return {
    vehicle_count: vehicleCount,
    unique_plate_count: Math.round(vehicleCount * uniqueRatio),
    baseline_vehicle_count: baseline,
    significant_change: baseline >= 20 && drift > 0.25,
  };
}

/* ------------------------------------------------------------- link metrics -- */

export interface LinkWindowMetric {
  vehicle_count: number;
  unique_vehicle_count: number;
  median_travel_time_seconds: number | null;
  baseline_travel_time_seconds: number | null;
  baseline_vehicle_count: number;
  congestion_score: number | null;
  travel_time_sample_count: number;
  significant_change: boolean;
}

const EMPTY_LINK_METRIC: LinkWindowMetric = {
  vehicle_count: 0,
  unique_vehicle_count: 0,
  median_travel_time_seconds: null,
  baseline_travel_time_seconds: null,
  baseline_vehicle_count: 0,
  congestion_score: null,
  travel_time_sample_count: 0,
  significant_change: false,
};

/**
 * Fraction of a from-camera's flow that continues onto a given link.
 *
 * Computed once per link and cached: a monthly report evaluates a few hundred
 * thousand link-windows, and rebuilding the split on each call dominated the
 * cost.
 */
const linkShareCache = new Map<string, number>();

function linkShare(fromCode: string, linkKey: string): number {
  const cached = linkShareCache.get(linkKey);
  if (cached !== undefined) return cached;

  const out = outgoingLinks.get(fromCode) ?? [];
  if (out.length === 0) return 0;

  // Uneven but stable split across the outgoing links.
  const weights = out.map(
    (link) => 0.5 + hashUnit('share', link.properties.camera_link_id) * 1.5,
  );
  const total = weights.reduce((sum, w) => sum + w, 0);

  out.forEach((link, index) => {
    const key = `${link.properties.from_camera_code}->${link.properties.to_camera_code}`;
    linkShareCache.set(key, (weights[index] ?? 1) / total);
  });

  return linkShareCache.get(linkKey) ?? 0;
}

/** `traffic_metrics_5m` for one directed link and one window. */
export function linkWindowMetric(
  fromCode: string,
  toCode: string,
  windowStartMs: number,
): LinkWindowMetric {
  const link = findLink(fromCode, toCode);
  if (!link) return EMPTY_LINK_METRIC;

  const linkKey = `${fromCode}->${toCode}`;
  const { free_flow_time_seconds: freeFlow, road_id: roadId } = link.properties;
  const roadCode = ROAD_CODE_BY_ROAD_ID.get(roadId ?? '') ?? 'MG-RD-C1';
  const sensitivity = ROAD_SENSITIVITY[roadCode] ?? 1;

  const load = loadFactor(windowStartMs);
  const captureFrom = captureRate(fromCode);
  const captureTo = captureRate(toCode);

  // Volume on the link: the upstream camera's flow, split across its exits.
  const upstreamPeak = CAMERA_PEAK_VOLUME[fromCode] ?? 100;
  const share = linkShare(fromCode, linkKey);
  const baselineVolume = Math.round(upstreamPeak * load * share * captureFrom);
  const vehicleCount = Math.max(
    0,
    Math.round(baselineVolume * noise(0.16, linkKey, windowStartMs, 'vol')),
  );

  // Travel time: free flow inflated by load, then by any active incident.
  const congestionFromLoad = sensitivity * Math.pow(load, 1.6);
  const expectedRatio = 1 + congestionFromLoad;
  const observedRatio =
    (expectedRatio + incidentExtra(linkKey, windowStartMs)) *
    noise(0.07, linkKey, windowStartMs, 'tt');

  // Journeys matched at BOTH ends. If either camera is down, matching fails —
  // which is the honest answer, not an interpolated travel time.
  const matchRate = 0.34 + hashUnit('match', linkKey) * 0.22;
  const sampleCount = Math.max(
    0,
    Math.round(vehicleCount * matchRate * captureTo * noise(0.25, linkKey, windowStartMs, 'n')),
  );

  if (sampleCount === 0 || captureFrom === 0 || captureTo === 0) {
    return {
      ...EMPTY_LINK_METRIC,
      vehicle_count: vehicleCount,
      unique_vehicle_count: Math.round(vehicleCount * 0.97),
      baseline_vehicle_count: baselineVolume,
    };
  }

  const median = Math.max(1, Math.round(freeFlow * observedRatio));
  const baselineTravel = Math.max(1, Math.round(freeFlow * expectedRatio));
  const drift = Math.abs(median - baselineTravel) / baselineTravel;

  return {
    vehicle_count: vehicleCount,
    unique_vehicle_count: Math.round(vehicleCount * 0.97),
    median_travel_time_seconds: median,
    baseline_travel_time_seconds: baselineTravel,
    baseline_vehicle_count: baselineVolume,
    congestion_score: Number((median / freeFlow).toFixed(3)),
    travel_time_sample_count: sampleCount,
    significant_change: sampleCount >= 5 && drift > 0.22,
  };
}

/**
 * Realistic travel time for one vehicle on one link at one instant — used by the
 * journey generator so materialised sightings agree with the congestion model.
 */
export function sampleTravelTimeSeconds(
  fromCode: string,
  toCode: string,
  atMs: number,
  jitterKey: string,
): number {
  const link = findLink(fromCode, toCode);
  if (!link) return 0;
  const metric = linkWindowMetric(fromCode, toCode, atMs);
  const centre =
    metric.median_travel_time_seconds ?? link.properties.free_flow_time_seconds * 1.2;
  // Individual vehicles spread widely around the median (signals, lane choice).
  return Math.max(8, Math.round(centre * (0.78 + hashUnit(jitterKey, atMs) * 0.55)));
}
