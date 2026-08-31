/**
 * Query engine over the fixture dataset.
 *
 * This is the part that stands in for Lane B's SQL. Where a rule is genuinely
 * part of the product (which sightings form a trajectory, when a transition is
 * infeasible, how a congestion figure is aggregated) it is implemented here in
 * full, so the UI is exercised against real behaviour rather than a canned
 * response. Where the real system would do something the browser can't, the
 * approximation is called out in a comment.
 *
 * Reads are pure. Writes (`acknowledgeAlert`, blacklist mutations) mutate the
 * in-memory dataset so the app behaves like a real backend for one session.
 */

import { bearingDegrees, haversineMeters, lineLengthMeters, speedKph } from '@/lib/geo';
import { normalizePlate } from '@/lib/plate';
import { stableUuid } from '@/lib/rng';
import {
  DAY_MS,
  FIVE_MIN_MS,
  endOfMonth,
  fiveMinuteWindows,
  floorToMinutes,
  isoDayOfWeek,
  isoWeekLabel,
  monthKey,
  startOfIsoWeek,
  startOfMonth,
} from '@/lib/time';
import type {
  AcknowledgeAlertRequest,
  AlertCounts,
  AlertsQuery,
  AnalyticsWindowQuery,
  BlacklistQuery,
  CreateBlacklistEntryRequest,
  FlowTrendQuery,
  FlowTrendResponse,
  HopStatus,
  LinkCongestionResponse,
  NodeMetricsResponse,
  OriginDestinationResponse,
  Paginated,
  PlateSuggestion,
  ReportListResponse,
  SightingsQuery,
  TrajectoryHop,
  TrajectoryQuery,
  TrajectoryResponse,
  TrajectorySegment,
  UpdateBlacklistEntryRequest,
} from '@/types/api';
import type {
  Alert,
  AlertBreakdown,
  AnomalyReason,
  BlacklistEntry,
  CongestionReport,
  DailySeriesPoint,
  FlowTrendPoint,
  HourlyProfileCell,
  LinkCongestion,
  NodeMetric,
  OriginDestinationPair,
  ReportGranularity,
  Severity,
  Sighting,
} from '@/types/domain';
import { cameraWindowMetric, linkWindowMetric } from './seed/demand';
import { cameraByCode, dataset, findLink } from './seed';
import { makePlate } from './seed/plates';

/* ------------------------------------------------------------------ helpers -- */

export class MockApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MockApiError';
  }
}

function paginate<T>(items: T[], limit = 50, offset = 0): Paginated<T> {
  const safeLimit = Math.max(1, Math.min(500, limit));
  const safeOffset = Math.max(0, offset);
  return {
    items: items.slice(safeOffset, safeOffset + safeLimit),
    total: items.length,
    limit: safeLimit,
    offset: safeOffset,
  };
}

function withinWindow(iso: string, from?: string, to?: string): boolean {
  const ms = Date.parse(iso);
  if (from !== undefined && ms < Date.parse(from)) return false;
  if (to !== undefined && ms > Date.parse(to)) return false;
  return true;
}

/** Sample-weighted mean. Used where the real query would take a true median. */
function weightedMean(
  entries: ReadonlyArray<{ value: number | null; weight: number }>,
): number | null {
  let sum = 0;
  let weight = 0;
  for (const entry of entries) {
    if (entry.value === null || entry.weight <= 0) continue;
    sum += entry.value * entry.weight;
    weight += entry.weight;
  }
  return weight === 0 ? null : sum / weight;
}

/* ------------------------------------------------------------------ network -- */

export function getCameras() {
  return dataset.cameras;
}

export function getCameraLinks() {
  return dataset.cameraLinks;
}

/* ------------------------------------------------------------ plate search -- */

export function searchPlates(rawQuery: string, limit = 12): PlateSuggestion[] {
  const query = normalizePlate(rawQuery);
  if (query.length < 2) return [];

  const blacklisted = new Set(
    dataset.blacklist
      .filter((entry) => entry.status === 'active')
      .map((entry) => entry.normalized_plate),
  );

  const matches: PlateSuggestion[] = [];

  for (const [plate, sightings] of dataset.sightingsByPlate) {
    if (!plate.includes(query)) continue;
    const last = sightings[sightings.length - 1];
    matches.push({
      plate_id: stableUuid(`plate:${plate}`),
      normalized_plate: plate,
      sighting_count: sightings.length,
      last_seen_at: last?.spotted_at ?? null,
      is_blacklisted: blacklisted.has(plate),
    });
  }

  // Prefix matches first, then blacklisted, then most-seen.
  matches.sort((a, b) => {
    const aPrefix = a.normalized_plate.startsWith(query) ? 0 : 1;
    const bPrefix = b.normalized_plate.startsWith(query) ? 0 : 1;
    if (aPrefix !== bPrefix) return aPrefix - bPrefix;
    if (a.is_blacklisted !== b.is_blacklisted) return a.is_blacklisted ? -1 : 1;
    return b.sighting_count - a.sighting_count;
  });

  return matches.slice(0, limit);
}

/* -------------------------------------------------------------- trajectory -- */

/**
 * Physical floor for a link transit. Anything faster is not a fast driver, it is
 * a data problem — a misread plate, a cloned plate, or a clock skew.
 */
const MINIMUM_TRAVEL_FRACTION = 0.6;

/** Heading must be within this many degrees of the link bearing to be plausible. */
const DIRECTION_TOLERANCE_DEGREES = 100;

/** Two sightings at the same camera closer than this are one pass, not two. */
const SAME_CAMERA_REDETECTION_SECONDS = 300;

/**
 * Continuity rules for splitting a plate's history into trips.
 *
 * Over a monitored link, a vehicle that took more than `LINK_CONTINUITY_FACTOR ×`
 * free-flow time (floored at 15 minutes so short links stay tolerant) did not
 * drive straight there — it stopped, and this is a new trip. Between unmonitored
 * cameras the tolerance is a flat 30 minutes, which is generous enough to cover a
 * genuine detour across the corridor.
 */
const LINK_CONTINUITY_FACTOR = 6;
const LINK_CONTINUITY_FLOOR_SECONDS = 900;
const UNMONITORED_CONTINUITY_SECONDS = 1800;

function isContinuous(travelSeconds: number, freeFlowSeconds: number | null): boolean {
  if (freeFlowSeconds === null) return travelSeconds <= UNMONITORED_CONTINUITY_SECONDS;
  return (
    travelSeconds <=
    Math.max(LINK_CONTINUITY_FLOOR_SECONDS, freeFlowSeconds * LINK_CONTINUITY_FACTOR)
  );
}

function angularDifference(a: number, b: number): number {
  const diff = Math.abs(((a - b + 540) % 360) - 180);
  return diff;
}

/**
 * Classify one transition against `camera_links` — the rule the trajectory
 * endpoint and the alert worker both need to agree on.
 */
function classifyHop(previous: Sighting, current: Sighting): TrajectoryHop | null {
  const departedMs = Date.parse(previous.spotted_at);
  const arrivedMs = Date.parse(current.spotted_at);
  const travelSeconds = Math.round((arrivedMs - departedMs) / 1000);

  if (
    previous.camera_code === current.camera_code &&
    travelSeconds < SAME_CAMERA_REDETECTION_SECONDS
  ) {
    return null;
  }

  const link = findLink(previous.camera_code, current.camera_code);

  if (!link) {
    // No monitored link: the vehicle used a road the network does not watch.
    // Reported honestly rather than invented, because an operator drawing
    // conclusions from a route needs to know which parts were never observed.
    return {
      from_sighting_id: previous.sighting_id,
      to_sighting_id: current.sighting_id,
      from_camera_id: previous.camera_id,
      to_camera_id: current.camera_id,
      from_camera_code: previous.camera_code,
      to_camera_code: current.camera_code,
      departed_at: previous.spotted_at,
      arrived_at: current.spotted_at,
      travel_time_seconds: travelSeconds,
      camera_link_id: null,
      road_name: null,
      direction_label: null,
      distance_meters: null,
      free_flow_time_seconds: null,
      implied_speed_kph: null,
      hop_status: 'no_link',
      path: null,
    };
  }

  const { distance_meters: distance, free_flow_time_seconds: freeFlow } = link.properties;
  const minimumSeconds = Math.round(freeFlow * MINIMUM_TRAVEL_FRACTION);

  let status: HopStatus = 'valid';
  if (travelSeconds < minimumSeconds) {
    status = 'impossible_travel_time';
  } else if (current.direction_degrees !== null) {
    const linkBearing = bearingDegrees(
      previous.camera_location,
      current.camera_location,
    );
    if (
      angularDifference(current.direction_degrees, linkBearing) >
      DIRECTION_TOLERANCE_DEGREES
    ) {
      status = 'wrong_direction';
    }
  }

  return {
    from_sighting_id: previous.sighting_id,
    to_sighting_id: current.sighting_id,
    from_camera_id: previous.camera_id,
    to_camera_id: current.camera_id,
    from_camera_code: previous.camera_code,
    to_camera_code: current.camera_code,
    departed_at: previous.spotted_at,
    arrived_at: current.spotted_at,
    travel_time_seconds: travelSeconds,
    camera_link_id: link.properties.camera_link_id,
    road_name: link.properties.road_name,
    direction_label: link.properties.direction_label,
    distance_meters: distance,
    free_flow_time_seconds: freeFlow,
    implied_speed_kph: speedKph(distance, travelSeconds),
    hop_status: status,
    path: link.geometry,
  };
}

export function getTrajectory(query: TrajectoryQuery): TrajectoryResponse {
  const plate = normalizePlate(query.plate);
  const all = (dataset.sightingsByPlate.get(plate) ?? []).filter((sighting) =>
    withinWindow(sighting.spotted_at, query.from, query.to),
  );

  // Routes are reconstructed from accepted sightings only — the schema's design
  // note. Everything else is returned separately so nothing is silently dropped.
  const includeUnvalidated = query.include_unvalidated ?? true;
  const accepted = all.filter((s) => s.validation_status === 'accepted');
  const excluded = includeUnvalidated
    ? all.filter((s) => s.validation_status !== 'accepted')
    : [];

  const ordered = [...accepted].sort(
    (a, b) => Date.parse(a.spotted_at) - Date.parse(b.spotted_at),
  );

  // Walk the timeline, cutting a new segment wherever the gap is too long to be
  // continuous travel. Hops are only emitted inside a segment.
  const hops: TrajectoryHop[] = [];
  const segments: TrajectorySegment[] = [];
  let currentRun: Sighting[] = [];
  const runHops: TrajectoryHop[][] = [];
  let currentRunHops: TrajectoryHop[] = [];

  const closeRun = () => {
    if (currentRun.length === 0) return;
    segments.push({
      segment_index: segments.length,
      started_at: currentRun[0]!.spotted_at,
      ended_at: currentRun[currentRun.length - 1]!.spotted_at,
      sighting_ids: currentRun.map((s) => s.sighting_id),
      camera_codes: currentRun.map((s) => s.camera_code),
      distance_meters: 0,
      duration_seconds: 0,
      average_speed_kph: null,
    });
    runHops.push(currentRunHops);
    currentRun = [];
    currentRunHops = [];
  };

  for (let i = 0; i < ordered.length; i += 1) {
    const sighting = ordered[i]!;
    if (i === 0) {
      currentRun.push(sighting);
      continue;
    }

    const previous = ordered[i - 1]!;
    const hop = classifyHop(previous, sighting);

    if (hop === null) {
      // Re-detection at the same camera: same pass, keep the run going.
      currentRun.push(sighting);
      continue;
    }

    if (isContinuous(hop.travel_time_seconds, hop.free_flow_time_seconds)) {
      hops.push(hop);
      currentRunHops.push(hop);
      currentRun.push(sighting);
    } else {
      closeRun();
      currentRun.push(sighting);
    }
  }
  closeRun();

  // Fill in per-segment measurements now the runs are known.
  segments.forEach((segment, index) => {
    const segHops = runHops[index] ?? [];
    const measured = segHops.filter((hop) => hop.distance_meters !== null);
    const distance = measured.reduce((sum, hop) => sum + (hop.distance_meters ?? 0), 0);
    const measuredSeconds = measured.reduce(
      (sum, hop) => sum + hop.travel_time_seconds,
      0,
    );
    segment.distance_meters = Math.round(distance);
    segment.duration_seconds = Math.round(
      (Date.parse(segment.ended_at) - Date.parse(segment.started_at)) / 1000,
    );
    segment.average_speed_kph = speedKph(distance, measuredSeconds);
  });

  // Totals across segments only — the gaps between trips are excluded, otherwise
  // parked time would be counted as travel and the average speed would collapse.
  const totalDistance = segments.reduce((sum, s) => sum + s.distance_meters, 0);
  const totalDuration = segments.reduce((sum, s) => sum + s.duration_seconds, 0);

  // Average speed uses only hops with known geometry: averaging over unmonitored
  // gaps would divide a distance we never measured by time we did.
  const measuredHops = hops.filter((hop) => hop.distance_meters !== null);
  const measuredDistance = measuredHops.reduce(
    (sum, hop) => sum + (hop.distance_meters ?? 0),
    0,
  );
  const measuredSeconds = measuredHops.reduce(
    (sum, hop) => sum + hop.travel_time_seconds,
    0,
  );

  const plateRow = dataset.plates.find((p) => p.normalized_plate === plate) ?? null;

  return {
    plate: { plate_id: plateRow?.plate_id ?? null, normalized_plate: plate },
    window: { from: query.from ?? null, to: query.to ?? null },
    sightings: ordered,
    excluded_sightings: excluded.sort(
      (a, b) => Date.parse(a.spotted_at) - Date.parse(b.spotted_at),
    ),
    hops,
    segments,
    summary: {
      sighting_count: all.length,
      accepted_count: ordered.length,
      excluded_count: excluded.length,
      distinct_camera_count: new Set(ordered.map((s) => s.camera_code)).size,
      first_seen_at: ordered[0]?.spotted_at ?? null,
      last_seen_at: ordered[ordered.length - 1]?.spotted_at ?? null,
      total_distance_meters: Math.round(totalDistance),
      total_duration_seconds: totalDuration,
      average_speed_kph: speedKph(measuredDistance, measuredSeconds),
      anomaly_hop_count: hops.filter(
        (hop) =>
          hop.hop_status === 'impossible_travel_time' ||
          hop.hop_status === 'wrong_direction',
      ).length,
      unmonitored_hop_count: hops.filter((hop) => hop.hop_status === 'no_link').length,
      segment_count: segments.length,
    },
  };
}

/* ---------------------------------------------------------------- sightings -- */

export function getSightings(query: SightingsQuery): Paginated<Sighting> {
  const plate = query.plate ? normalizePlate(query.plate) : undefined;

  const filtered = dataset.sightings
    .filter((sighting) => {
      if (query.camera_code && sighting.camera_code !== query.camera_code) return false;
      if (
        plate &&
        sighting.normalized_plate !== plate &&
        sighting.normalized_plate_candidate !== plate
      ) {
        return false;
      }
      if (
        query.validation_status &&
        query.validation_status.length > 0 &&
        !query.validation_status.includes(sighting.validation_status)
      ) {
        return false;
      }
      return withinWindow(sighting.spotted_at, query.from, query.to);
    })
    .slice()
    .sort((a, b) => Date.parse(b.spotted_at) - Date.parse(a.spotted_at));

  return paginate(filtered, query.limit, query.offset);
}

/* ------------------------------------------------------------------- alerts -- */

function matchesAlertQuery(alert: Alert, query: AlertsQuery): boolean {
  if (query.alert_type?.length && !query.alert_type.includes(alert.alert_type)) return false;
  if (query.status?.length && !query.status.includes(alert.status)) return false;
  if (query.severity?.length) {
    if (alert.severity === null || !query.severity.includes(alert.severity)) return false;
  }
  if (query.anomaly_reason?.length) {
    if (alert.anomaly_reason === null || !query.anomaly_reason.includes(alert.anomaly_reason)) {
      return false;
    }
  }
  if (query.plate) {
    const plate = normalizePlate(query.plate);
    if (!alert.normalized_plate?.includes(plate)) return false;
  }
  if (query.camera_code && alert.camera_code !== query.camera_code) return false;
  return withinWindow(alert.created_at, query.from, query.to);
}

export function getAlerts(query: AlertsQuery): Paginated<Alert> {
  const filtered = dataset.alerts
    .filter((alert) => matchesAlertQuery(alert, query))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return paginate(filtered, query.limit ?? 40, query.offset);
}

export function getAlertCounts(query: AlertsQuery): AlertCounts {
  // Counts ignore the caller's type/status/severity filters so the filter chips
  // can show what selecting them *would* yield, but respect the time window.
  const scoped = dataset.alerts.filter((alert) =>
    withinWindow(alert.created_at, query.from, query.to),
  );

  const bySeverity: Record<Severity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  const byReason: Record<AnomalyReason, number> = {
    impossible_travel_time: 0,
    wrong_direction: 0,
    suspected_clone: 0,
  };

  let newCount = 0;
  let acknowledged = 0;
  let resolved = 0;
  let blacklist = 0;
  let routeAnomaly = 0;

  for (const alert of scoped) {
    if (alert.status === 'new') newCount += 1;
    if (alert.status === 'acknowledged') acknowledged += 1;
    if (alert.status === 'resolved') resolved += 1;
    if (alert.alert_type === 'blacklist') blacklist += 1;
    if (alert.alert_type === 'route_anomaly') routeAnomaly += 1;
    if (alert.severity) bySeverity[alert.severity] += 1;
    if (alert.anomaly_reason) byReason[alert.anomaly_reason] += 1;
  }

  return {
    total: scoped.length,
    new: newCount,
    acknowledged,
    resolved,
    blacklist,
    route_anomaly: routeAnomaly,
    by_severity: bySeverity,
    by_anomaly_reason: byReason,
  };
}

export function acknowledgeAlert(
  alertId: string,
  body: AcknowledgeAlertRequest,
): Alert {
  const index = dataset.alerts.findIndex((alert) => alert.alert_id === alertId);
  if (index < 0) throw new MockApiError(404, `Alert ${alertId} not found`);

  const existing = dataset.alerts[index]!;
  const updated: Alert = {
    ...existing,
    status: body.status ?? 'acknowledged',
    acknowledged_at: new Date().toISOString(),
    acknowledged_by: body.acknowledged_by,
    resolution_notes: body.resolution_notes ?? existing.resolution_notes,
  };
  dataset.alerts[index] = updated;
  return updated;
}

/* ---------------------------------------------------------------- blacklist -- */

export function getBlacklist(query: BlacklistQuery): Paginated<BlacklistEntry> {
  const search = query.q ? normalizePlate(query.q) : undefined;

  const filtered = dataset.blacklist
    .filter((entry) => {
      if (query.status?.length && !query.status.includes(entry.status)) return false;
      if (query.severity?.length && !query.severity.includes(entry.severity)) return false;
      if (search && !entry.normalized_plate.includes(search)) {
        // Also allow searching by case reference, which is how a case officer
        // would actually look one up.
        if (!entry.case_reference?.toUpperCase().includes(search)) return false;
      }
      return true;
    })
    .sort((a, b) => Date.parse(b.active_from) - Date.parse(a.active_from));

  return paginate(filtered, query.limit ?? 50, query.offset);
}

export function createBlacklistEntry(
  body: CreateBlacklistEntryRequest,
): BlacklistEntry {
  const plate = normalizePlate(body.plate);
  if (plate.length < 4) throw new MockApiError(422, 'Plate looks too short to be valid');
  if (body.reason.trim().length === 0) throw new MockApiError(422, 'A reason is required');

  // Resolve-or-create the `plates` row, same as the real endpoint must.
  if (!dataset.plates.some((p) => p.normalized_plate === plate)) {
    (dataset.plates as ReturnType<typeof makePlate>[]).push(makePlate(plate));
  }

  const existingActive = dataset.blacklist.find(
    (entry) => entry.normalized_plate === plate && entry.status === 'active',
  );
  if (existingActive) {
    throw new MockApiError(409, `${plate} already has an active blacklist entry`);
  }

  const history = dataset.sightingsByPlate.get(plate) ?? [];
  const entry: BlacklistEntry = {
    blacklist_entry_id: stableUuid(`blacklist:${plate}:${Date.now()}`),
    plate_id: stableUuid(`plate:${plate}`),
    normalized_plate: plate,
    reason: body.reason.trim(),
    severity: body.severity,
    status: 'active',
    active_from: body.active_from ?? new Date().toISOString(),
    active_until: body.active_until ?? null,
    added_by: body.added_by,
    case_reference: body.case_reference ?? null,
    sighting_count: history.length,
    last_seen_at: history[history.length - 1]?.spotted_at ?? null,
  };

  dataset.blacklist.unshift(entry);
  return entry;
}

export function updateBlacklistEntry(
  entryId: string,
  body: UpdateBlacklistEntryRequest,
): BlacklistEntry {
  const index = dataset.blacklist.findIndex((e) => e.blacklist_entry_id === entryId);
  if (index < 0) throw new MockApiError(404, `Blacklist entry ${entryId} not found`);

  const existing = dataset.blacklist[index]!;
  const updated: BlacklistEntry = {
    ...existing,
    status: body.status ?? existing.status,
    severity: body.severity ?? existing.severity,
    reason: body.reason ?? existing.reason,
    active_until:
      body.active_until === undefined ? existing.active_until : body.active_until,
  };
  dataset.blacklist[index] = updated;
  return updated;
}

/* -------------------------------------------------------- analytics: nodes --- */

export function getNodeMetrics(query: AnalyticsWindowQuery): NodeMetricsResponse {
  const windows = fiveMinuteWindows(query.from, query.to);

  const nodes: NodeMetric[] = dataset.cameras.features.map((feature) => {
    const code = feature.properties.camera_code;
    let vehicles = 0;
    let unique = 0;
    let baseline = 0;
    let peak = 0;
    let significant = false;

    for (const windowStart of windows) {
      const metric = cameraWindowMetric(code, windowStart);
      vehicles += metric.vehicle_count;
      unique += metric.unique_plate_count;
      baseline += metric.baseline_vehicle_count;
      peak = Math.max(peak, metric.vehicle_count);
      significant = significant || metric.significant_change;
    }

    return {
      camera_id: feature.properties.camera_id,
      camera_code: code,
      display_name: feature.properties.display_name,
      status: feature.properties.status,
      location: feature.geometry.coordinates,
      vehicle_count: vehicles,
      unique_plate_count: unique,
      peak_5m_vehicle_count: peak,
      significant_change: significant,
      vs_baseline_pct:
        baseline > 0 ? Number((((vehicles - baseline) / baseline) * 100).toFixed(1)) : null,
    };
  });

  return {
    window: query,
    nodes,
    max_vehicle_count: nodes.reduce((max, node) => Math.max(max, node.vehicle_count), 0),
  };
}

/* -------------------------------------------------------- analytics: links --- */

export function getLinkCongestion(query: AnalyticsWindowQuery): LinkCongestionResponse {
  const windows = fiveMinuteWindows(query.from, query.to);

  const links: LinkCongestion[] = dataset.cameraLinks.features.map((feature) => {
    const props = feature.properties;
    let vehicles = 0;
    let unique = 0;
    let samples = 0;
    let baselineVolume = 0;
    let significant = false;
    const travelSamples: { value: number | null; weight: number }[] = [];
    const baselineSamples: { value: number | null; weight: number }[] = [];

    for (const windowStart of windows) {
      const metric = linkWindowMetric(
        props.from_camera_code,
        props.to_camera_code,
        windowStart,
      );
      vehicles += metric.vehicle_count;
      unique += metric.unique_vehicle_count;
      samples += metric.travel_time_sample_count;
      baselineVolume += metric.baseline_vehicle_count;
      significant = significant || metric.significant_change;
      travelSamples.push({
        value: metric.median_travel_time_seconds,
        weight: metric.travel_time_sample_count,
      });
      baselineSamples.push({
        value: metric.baseline_travel_time_seconds,
        weight: metric.travel_time_sample_count,
      });
    }

    // Real query: median over the matched journeys in the range. Here: the
    // window medians weighted by their sample counts — same shape, close enough
    // for a demo, and it degrades to null when nothing was matched.
    const median = weightedMean(travelSamples);
    const baselineTravel = weightedMean(baselineSamples);
    const medianRounded = median === null ? null : Math.round(median);

    return {
      camera_link_id: props.camera_link_id,
      from_camera_id: props.from_camera_id,
      to_camera_id: props.to_camera_id,
      from_camera_code: props.from_camera_code,
      to_camera_code: props.to_camera_code,
      road_name: props.road_name,
      direction_label: props.direction_label,
      distance_meters: props.distance_meters,
      free_flow_time_seconds: props.free_flow_time_seconds,
      speed_limit_kph: props.speed_limit_kph,
      vehicle_count: vehicles,
      unique_vehicle_count: unique,
      median_travel_time_seconds: medianRounded,
      baseline_travel_time_seconds: baselineTravel === null ? null : Math.round(baselineTravel),
      baseline_vehicle_count: baselineVolume,
      congestion_score:
        medianRounded === null
          ? null
          : Number((medianRounded / props.free_flow_time_seconds).toFixed(3)),
      travel_time_sample_count: samples,
      significant_change: significant,
      derived_speed_kph: speedKph(props.distance_meters, medianRounded),
      path: feature.geometry,
    };
  });

  const scored = links.filter((link) => link.congestion_score !== null);

  return {
    window: query,
    links,
    network_avg_congestion_score:
      scored.length === 0
        ? null
        : Number(
            (
              scored.reduce((sum, link) => sum + (link.congestion_score ?? 0), 0) /
              scored.length
            ).toFixed(3),
          ),
  };
}

/* --------------------------------------------------- analytics: flow trends -- */

export function getFlowTrends(query: FlowTrendQuery): FlowTrendResponse {
  const bucketMinutes = query.bucket_minutes ?? 15;
  const windows = fiveMinuteWindows(query.from, query.to);

  interface Bucket {
    vehicles: number;
    unique: number;
    baseline: number;
    travel: { value: number | null; weight: number }[];
    scores: number[];
  }

  const buckets = new Map<number, Bucket>();
  const bucketFor = (ms: number): Bucket => {
    const key = floorToMinutes(ms, bucketMinutes).getTime();
    const existing = buckets.get(key);
    if (existing) return existing;
    const fresh: Bucket = { vehicles: 0, unique: 0, baseline: 0, travel: [], scores: [] };
    buckets.set(key, fresh);
    return fresh;
  };

  let targetLabel = 'Whole network';

  if (query.scope === 'camera') {
    const code = query.target_id;
    const camera = code ? cameraByCode.get(code) : undefined;
    if (!camera) throw new MockApiError(404, `Camera ${code ?? '(missing)'} not found`);
    targetLabel = `${camera.properties.camera_code} · ${camera.properties.display_name}`;

    for (const windowStart of windows) {
      const metric = cameraWindowMetric(camera.properties.camera_code, windowStart);
      const bucket = bucketFor(windowStart);
      bucket.vehicles += metric.vehicle_count;
      bucket.unique += metric.unique_plate_count;
      bucket.baseline += metric.baseline_vehicle_count;
    }
  } else if (query.scope === 'link') {
    const link = dataset.cameraLinks.features.find(
      (f) => f.properties.camera_link_id === query.target_id,
    );
    if (!link) throw new MockApiError(404, `Link ${query.target_id ?? '(missing)'} not found`);
    targetLabel = `${link.properties.from_camera_code} → ${link.properties.to_camera_code}`;

    for (const windowStart of windows) {
      const metric = linkWindowMetric(
        link.properties.from_camera_code,
        link.properties.to_camera_code,
        windowStart,
      );
      const bucket = bucketFor(windowStart);
      bucket.vehicles += metric.vehicle_count;
      bucket.unique += metric.unique_vehicle_count;
      bucket.baseline += metric.baseline_vehicle_count;
      bucket.travel.push({
        value: metric.median_travel_time_seconds,
        weight: metric.travel_time_sample_count,
      });
      if (metric.congestion_score !== null) bucket.scores.push(metric.congestion_score);
    }
  } else {
    for (const windowStart of windows) {
      const bucket = bucketFor(windowStart);
      for (const feature of dataset.cameras.features) {
        const metric = cameraWindowMetric(feature.properties.camera_code, windowStart);
        bucket.vehicles += metric.vehicle_count;
        bucket.unique += metric.unique_plate_count;
        bucket.baseline += metric.baseline_vehicle_count;
      }
      for (const feature of dataset.cameraLinks.features) {
        const metric = linkWindowMetric(
          feature.properties.from_camera_code,
          feature.properties.to_camera_code,
          windowStart,
        );
        if (metric.congestion_score !== null) bucket.scores.push(metric.congestion_score);
        bucket.travel.push({
          value: metric.median_travel_time_seconds,
          weight: metric.travel_time_sample_count,
        });
      }
    }
  }

  const points: FlowTrendPoint[] = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([windowStart, bucket]) => {
      const travel = weightedMean(bucket.travel);
      const score =
        bucket.scores.length === 0
          ? null
          : Number(
              (bucket.scores.reduce((s, v) => s + v, 0) / bucket.scores.length).toFixed(3),
            );
      return {
        window_start: new Date(windowStart).toISOString(),
        vehicle_count: bucket.vehicles,
        unique_vehicle_count: bucket.unique,
        median_travel_time_seconds: travel === null ? null : Math.round(travel),
        congestion_score: score,
        baseline_vehicle_count: bucket.baseline,
      };
    });

  return {
    window: { from: query.from, to: query.to },
    scope: query.scope,
    target_id: query.target_id ?? null,
    target_label: targetLabel,
    bucket_minutes: bucketMinutes,
    points,
  };
}

/* ------------------------------------------- analytics: origin–destination --- */

/**
 * O-D pairs from materialised journeys: the first and last camera of each
 * journey, not each link hop. That is what an O-D matrix means — where trips
 * start and end — and it is why this reads from journeys rather than the demand
 * model, which has no notion of an individual trip.
 */
export function getOriginDestination(
  query: AnalyticsWindowQuery,
): OriginDestinationResponse {
  const fromMs = Date.parse(query.from);
  const toMs = Date.parse(query.to);

  const pairKey = (from: string, to: string) => `${from}->${to}`;
  const tally = new Map<string, { from: string; to: string; durations: number[] }>();
  const originTotals = new Map<string, number>();
  let totalJourneys = 0;

  for (const journey of dataset.journeys) {
    const startMs = Date.parse(journey.started_at);
    if (startMs < fromMs || startMs > toMs) continue;

    const origin = journey.camera_codes[0];
    const destination = journey.camera_codes[journey.camera_codes.length - 1];
    if (!origin || !destination || origin === destination) continue;

    const key = pairKey(origin, destination);
    const entry = tally.get(key) ?? { from: origin, to: destination, durations: [] };
    entry.durations.push(
      Math.round((Date.parse(journey.ended_at) - startMs) / 1000),
    );
    tally.set(key, entry);
    originTotals.set(origin, (originTotals.get(origin) ?? 0) + 1);
    totalJourneys += 1;
  }

  const pairs: OriginDestinationPair[] = [...tally.values()].map((entry) => {
    const sorted = [...entry.durations].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? null;
    const originTotal = originTotals.get(entry.from) ?? 0;
    return {
      from_camera_id: cameraByCode.get(entry.from)?.properties.camera_id ?? entry.from,
      to_camera_id: cameraByCode.get(entry.to)?.properties.camera_id ?? entry.to,
      from_camera_code: entry.from,
      to_camera_code: entry.to,
      journey_count: entry.durations.length,
      median_travel_time_seconds: median,
      share_pct:
        originTotal === 0
          ? 0
          : Number(((entry.durations.length / originTotal) * 100).toFixed(1)),
    };
  });

  pairs.sort((a, b) => b.journey_count - a.journey_count);

  return {
    window: query,
    camera_codes: [...dataset.cameraCodes],
    pairs,
    total_journeys: totalJourneys,
  };
}

/* ------------------------------------------------------------------ reports -- */

const REPORT_PERIOD_COUNT = 8;

function periodRange(
  granularity: ReportGranularity,
  period: string,
): { from: number; to: number; label: string } {
  if (granularity === 'month') {
    const [yearText, monthText] = period.split('-');
    const year = Number(yearText);
    const month = Number(monthText) - 1;
    if (!Number.isFinite(year) || !Number.isFinite(month)) {
      throw new MockApiError(422, `Unparseable month period: ${period}`);
    }
    const start = new Date(year, month, 1);
    return {
      from: start.getTime(),
      to: endOfMonth(start).getTime(),
      label: start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    };
  }

  // ISO week: walk back from the current week until the label matches.
  let cursor = startOfIsoWeek(dataset.now);
  for (let i = 0; i < 200; i += 1) {
    if (isoWeekLabel(cursor) === period) {
      return {
        from: cursor.getTime(),
        to: cursor.getTime() + 7 * DAY_MS,
        label: period,
      };
    }
    cursor = new Date(cursor.getTime() - 7 * DAY_MS);
  }
  throw new MockApiError(422, `Unknown week period: ${period}`);
}

export function getReportPeriods(granularity: ReportGranularity): ReportListResponse {
  const periods: ReportListResponse['periods'] = [];

  if (granularity === 'week') {
    let cursor = startOfIsoWeek(dataset.now);
    for (let i = 0; i < REPORT_PERIOD_COUNT; i += 1) {
      if (cursor.getTime() < dataset.historyStart) break;
      const label = isoWeekLabel(cursor);
      periods.push({ granularity, label, period: label });
      cursor = new Date(cursor.getTime() - 7 * DAY_MS);
    }
  } else {
    let cursor = startOfMonth(dataset.now);
    for (let i = 0; i < 4; i += 1) {
      if (endOfMonth(cursor).getTime() < dataset.historyStart) break;
      periods.push({
        granularity,
        label: cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
        period: monthKey(cursor),
      });
      cursor = startOfMonth(new Date(cursor.getTime() - 1));
    }
  }

  return { periods };
}

interface PeriodAggregate {
  totalSightings: number;
  uniquePlates: number;
  busiestCamera: string | null;
  avgScore: number | null;
  peakScore: number | null;
  worstLinkLabel: string | null;
  delayHours: number;
  links: LinkCongestion[];
  daily: DailySeriesPoint[];
  hourly: HourlyProfileCell[];
}

/**
 * Aggregate one reporting period straight from the demand model.
 *
 * A week is 2 016 five-minute windows; the whole network is 12 cameras and 26
 * links, so a weekly report evaluates ~77 000 metric calls and a monthly one
 * ~4× that. Cheap arithmetic, but the results are cached below because the
 * report view re-renders on every filter change.
 */
function aggregatePeriod(fromMs: number, toMs: number): PeriodAggregate {
  const clampedTo = Math.min(toMs, dataset.now);
  const windows = fiveMinuteWindows(fromMs, clampedTo);

  const cameraTotals = new Map<string, number>();
  let totalSightings = 0;
  let uniquePlates = 0;

  const dailyMap = new Map<string, { vehicles: number; baseline: number; scores: number[] }>();
  const hourlyMap = new Map<string, { scores: number[]; vehicles: number }>();

  for (const windowStart of windows) {
    const date = new Date(windowStart);
    const dayKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const hourKey = `${isoDayOfWeek(date)}:${date.getHours()}`;

    const daily = dailyMap.get(dayKey) ?? { vehicles: 0, baseline: 0, scores: [] };
    const hourly = hourlyMap.get(hourKey) ?? { scores: [], vehicles: 0 };

    for (const feature of dataset.cameras.features) {
      const code = feature.properties.camera_code;
      const metric = cameraWindowMetric(code, windowStart);
      totalSightings += metric.vehicle_count;
      uniquePlates += metric.unique_plate_count;
      cameraTotals.set(code, (cameraTotals.get(code) ?? 0) + metric.vehicle_count);
      daily.vehicles += metric.vehicle_count;
      daily.baseline += metric.baseline_vehicle_count;
      hourly.vehicles += metric.vehicle_count;
    }

    dailyMap.set(dayKey, daily);
    hourlyMap.set(hourKey, hourly);
  }

  // Link-level pass, kept separate so the two loops stay readable.
  const linkAccumulator = new Map<
    string,
    {
      vehicles: number;
      unique: number;
      samples: number;
      baselineVolume: number;
      travel: { value: number | null; weight: number }[];
      baseline: { value: number | null; weight: number }[];
      significant: boolean;
      peakScore: number;
    }
  >();

  for (const windowStart of windows) {
    const date = new Date(windowStart);
    const dayKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const hourKey = `${isoDayOfWeek(date)}:${date.getHours()}`;

    for (const feature of dataset.cameraLinks.features) {
      const props = feature.properties;
      const metric = linkWindowMetric(
        props.from_camera_code,
        props.to_camera_code,
        windowStart,
      );

      const acc =
        linkAccumulator.get(props.camera_link_id) ??
        {
          vehicles: 0,
          unique: 0,
          samples: 0,
          baselineVolume: 0,
          travel: [] as { value: number | null; weight: number }[],
          baseline: [] as { value: number | null; weight: number }[],
          significant: false,
          peakScore: 0,
        };

      acc.vehicles += metric.vehicle_count;
      acc.unique += metric.unique_vehicle_count;
      acc.samples += metric.travel_time_sample_count;
      acc.baselineVolume += metric.baseline_vehicle_count;
      acc.travel.push({
        value: metric.median_travel_time_seconds,
        weight: metric.travel_time_sample_count,
      });
      acc.baseline.push({
        value: metric.baseline_travel_time_seconds,
        weight: metric.travel_time_sample_count,
      });
      acc.significant = acc.significant || metric.significant_change;
      acc.peakScore = Math.max(acc.peakScore, metric.congestion_score ?? 0);
      linkAccumulator.set(props.camera_link_id, acc);

      if (metric.congestion_score !== null) {
        dailyMap.get(dayKey)?.scores.push(metric.congestion_score);
        hourlyMap.get(hourKey)?.scores.push(metric.congestion_score);
      }
    }
  }

  const links: LinkCongestion[] = dataset.cameraLinks.features.map((feature) => {
    const props = feature.properties;
    const acc = linkAccumulator.get(props.camera_link_id);
    const median = acc ? weightedMean(acc.travel) : null;
    const baseline = acc ? weightedMean(acc.baseline) : null;
    const medianRounded = median === null ? null : Math.round(median);

    return {
      camera_link_id: props.camera_link_id,
      from_camera_id: props.from_camera_id,
      to_camera_id: props.to_camera_id,
      from_camera_code: props.from_camera_code,
      to_camera_code: props.to_camera_code,
      road_name: props.road_name,
      direction_label: props.direction_label,
      distance_meters: props.distance_meters,
      free_flow_time_seconds: props.free_flow_time_seconds,
      speed_limit_kph: props.speed_limit_kph,
      vehicle_count: acc?.vehicles ?? 0,
      unique_vehicle_count: acc?.unique ?? 0,
      median_travel_time_seconds: medianRounded,
      baseline_travel_time_seconds: baseline === null ? null : Math.round(baseline),
      baseline_vehicle_count: acc?.baselineVolume ?? 0,
      congestion_score:
        medianRounded === null
          ? null
          : Number((medianRounded / props.free_flow_time_seconds).toFixed(3)),
      travel_time_sample_count: acc?.samples ?? 0,
      significant_change: acc?.significant ?? false,
      derived_speed_kph: speedKph(props.distance_meters, medianRounded),
      path: feature.geometry,
    };
  });

  const scored = links.filter((link) => link.congestion_score !== null);
  const sortedWorst = [...scored].sort(
    (a, b) => (b.congestion_score ?? 0) - (a.congestion_score ?? 0),
  );
  const worst = sortedWorst[0];

  // Delay: extra seconds over the window-of-week baseline, across matched
  // journeys. This is where `baseline_travel_time_seconds` earns its keep.
  const delaySeconds = links.reduce((sum, link) => {
    if (
      link.median_travel_time_seconds === null ||
      link.baseline_travel_time_seconds === null
    ) {
      return sum;
    }
    const perVehicle = link.median_travel_time_seconds - link.baseline_travel_time_seconds;
    return sum + Math.max(0, perVehicle) * link.travel_time_sample_count;
  }, 0);

  const busiest = [...cameraTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const daily: DailySeriesPoint[] = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({
      date,
      vehicle_count: value.vehicles,
      avg_congestion_score:
        value.scores.length === 0
          ? null
          : Number(
              (value.scores.reduce((s, v) => s + v, 0) / value.scores.length).toFixed(3),
            ),
      baseline_vehicle_count: value.baseline,
    }));

  const hourly: HourlyProfileCell[] = [];
  for (let day = 0; day < 7; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const value = hourlyMap.get(`${day}:${hour}`);
      hourly.push({
        day_of_week: day,
        hour,
        congestion_score:
          !value || value.scores.length === 0
            ? null
            : Number(
                (value.scores.reduce((s, v) => s + v, 0) / value.scores.length).toFixed(3),
              ),
        vehicle_count: value?.vehicles ?? 0,
      });
    }
  }

  return {
    totalSightings,
    uniquePlates,
    busiestCamera: busiest,
    avgScore:
      scored.length === 0
        ? null
        : Number(
            (
              scored.reduce((sum, link) => sum + (link.congestion_score ?? 0), 0) /
              scored.length
            ).toFixed(3),
          ),
    peakScore:
      scored.length === 0
        ? null
        : Number(Math.max(...scored.map((l) => l.congestion_score ?? 0)).toFixed(3)),
    worstLinkLabel: worst
      ? `${worst.from_camera_code} → ${worst.to_camera_code}${worst.road_name ? ` (${worst.road_name})` : ''}`
      : null,
    delayHours: Number((delaySeconds / 3600).toFixed(1)),
    links: sortedWorst,
    daily,
    hourly,
  };
}

const periodCache = new Map<string, PeriodAggregate>();

function cachedAggregate(key: string, fromMs: number, toMs: number): PeriodAggregate {
  const hit = periodCache.get(key);
  if (hit) return hit;
  const value = aggregatePeriod(fromMs, toMs);
  periodCache.set(key, value);
  return value;
}

export function getReport(
  granularity: ReportGranularity,
  period?: string,
): CongestionReport {
  const resolvedPeriod =
    period ??
    (granularity === 'week' ? isoWeekLabel(dataset.now) : monthKey(dataset.now));

  const range = periodRange(granularity, resolvedPeriod);
  const current = cachedAggregate(`${granularity}:${resolvedPeriod}`, range.from, range.to);

  // Previous period, for the comparison block.
  const previousFrom =
    granularity === 'week'
      ? range.from - 7 * DAY_MS
      : startOfMonth(new Date(range.from - 1)).getTime();
  const previousTo = granularity === 'week' ? range.from : range.from;
  const previousLabel =
    granularity === 'week'
      ? isoWeekLabel(new Date(previousFrom))
      : new Date(previousFrom).toLocaleDateString(undefined, {
          month: 'long',
          year: 'numeric',
        });

  let comparison: CongestionReport['comparison'] = null;
  if (previousFrom >= dataset.historyStart) {
    const previous = cachedAggregate(
      `${granularity}:prev:${previousLabel}`,
      previousFrom,
      previousTo,
    );
    comparison = {
      previous_label: previousLabel,
      congestion_delta_pct:
        previous.avgScore && current.avgScore
          ? Number(
              (((current.avgScore - previous.avgScore) / previous.avgScore) * 100).toFixed(1),
            )
          : null,
      volume_delta_pct:
        previous.totalSightings > 0
          ? Number(
              (
                ((current.totalSightings - previous.totalSightings) /
                  previous.totalSightings) *
                100
              ).toFixed(1),
            )
          : null,
    };
  }

  const periodAlerts = dataset.alerts.filter((alert) => {
    const ms = Date.parse(alert.created_at);
    return ms >= range.from && ms < range.to;
  });

  const breakdownMap = new Map<string, AlertBreakdown>();
  for (const alert of periodAlerts) {
    const key = `${alert.alert_type}:${alert.anomaly_reason ?? ''}`;
    const existing = breakdownMap.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      breakdownMap.set(key, {
        alert_type: alert.alert_type,
        anomaly_reason: alert.anomaly_reason,
        count: 1,
      });
    }
  }

  return {
    period: {
      granularity,
      label: range.label,
      from: new Date(range.from).toISOString(),
      to: new Date(Math.min(range.to, dataset.now)).toISOString(),
    },
    summary: {
      total_sightings: current.totalSightings,
      unique_plates: current.uniquePlates,
      avg_congestion_score: current.avgScore,
      peak_congestion_score: current.peakScore,
      busiest_camera_code: current.busiestCamera,
      worst_link_label: current.worstLinkLabel,
      alert_count: periodAlerts.length,
      total_delay_hours: current.delayHours,
    },
    comparison,
    worst_links: current.links.slice(0, 10),
    hourly_profile: current.hourly,
    daily_series: current.daily,
    alerts_by_type: [...breakdownMap.values()].sort((a, b) => b.count - a.count),
  };
}

/* --------------------------------------------------------------- live feed --- */

/**
 * Append a sighting minted by the live mock stream, keeping the dataset's
 * indexes and ordering intact so every other query sees it immediately.
 */
export function ingestLiveSighting(sighting: Sighting): void {
  (dataset.sightings as Sighting[]).push(sighting);

  const key = sighting.normalized_plate ?? sighting.normalized_plate_candidate;
  if (key) {
    const list = dataset.sightingsByPlate.get(key) ?? [];
    list.push(sighting);
    dataset.sightingsByPlate.set(key, list);
  }

  const camera = cameraByCode.get(sighting.camera_code);
  if (camera) camera.properties.last_seen_at = sighting.spotted_at;
}

export function ingestLiveAlert(alert: Alert): void {
  if (dataset.alerts.some((existing) => existing.dedup_key === alert.dedup_key)) return;
  dataset.alerts.unshift(alert);
}

export function findSighting(sightingId: string): Sighting | undefined {
  return dataset.sightings.find((s) => s.sighting_id === sightingId);
}

/** Straight-line distance between two cameras — used by clone-alert details. */
export function cameraSeparationMeters(fromCode: string, toCode: string): number {
  const from = cameraByCode.get(fromCode);
  const to = cameraByCode.get(toCode);
  if (!from || !to) return 0;
  return Math.round(haversineMeters(from.geometry.coordinates, to.geometry.coordinates));
}

/** Total monitored network length, for the "simulated network" summary. */
export function networkLengthMeters(): number {
  return Math.round(
    dataset.cameraLinks.features.reduce(
      (sum, feature) => sum + lineLengthMeters(feature.geometry.coordinates),
      0,
    ) / 2, // both directions of each corridor are stored
  );
}

export const FIVE_MINUTES_MS = FIVE_MIN_MS;
