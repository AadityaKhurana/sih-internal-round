/**
 * Request/response shapes for every endpoint the dashboard calls, plus the
 * WebSocket envelope. This is the frontend's half of the REST contract — see
 * `frontend/API_CONTRACT.md` for the endpoint table handed to Lane B.
 *
 * The mock transport in `@/api/mock` implements exactly these shapes, so
 * flipping `VITE_USE_MOCK` to false must not require a component change.
 */

import type {
  Alert,
  AlertStatus,
  AlertType,
  AnomalyReason,
  BlacklistStatus,
  CameraLinkProperties,
  CameraProperties,
  CongestionReport,
  FlowTrendPoint,
  LinkCongestion,
  NodeMetric,
  OriginDestinationPair,
  ReportGranularity,
  Severity,
  Sighting,
  ValidationStatus,
} from './domain';
import type { FeatureCollection, LineStringGeometry, PointGeometry } from './geo';

/* ------------------------------------------------------------- envelopes ---- */

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Shape the API returns on a non-2xx. */
export interface ApiErrorBody {
  detail: string;
  code?: string;
}

/* ---------------------------------------------------------------- network --- */

/** `GET /cameras` */
export type CamerasResponse = FeatureCollection<PointGeometry, CameraProperties>;

/** `GET /camera-links` */
export type CameraLinksResponse = FeatureCollection<
  LineStringGeometry,
  CameraLinkProperties
>;

/* ------------------------------------------------------------- trajectory -- */

export interface TrajectoryQuery {
  plate: string;
  /** RFC 3339. Omit both for "all history". */
  from?: string;
  to?: string;
  /** Include non-accepted sightings in `excluded_sightings`. Default true. */
  include_unvalidated?: boolean;
}

/**
 * Verdict for one consecutive pair of sightings, produced by validating the
 * transition against `camera_links`.
 *  - `valid`                  — a link exists and the travel time is plausible.
 *  - `no_link`                — no monitored link between the two cameras; the
 *                               vehicle used an unmonitored road. Drawn dashed.
 *  - `impossible_travel_time` — faster than the link's minimum travel time.
 *  - `wrong_direction`        — heading contradicts the link's direction.
 */
export type HopStatus =
  | 'valid'
  | 'no_link'
  | 'impossible_travel_time'
  | 'wrong_direction';

/** One leg of a reconstructed trajectory. */
export interface TrajectoryHop {
  from_sighting_id: string;
  to_sighting_id: string;
  from_camera_id: string;
  to_camera_id: string;
  from_camera_code: string;
  to_camera_code: string;
  departed_at: string;
  arrived_at: string;
  travel_time_seconds: number;
  /** Null when `hop_status = 'no_link'`. */
  camera_link_id: string | null;
  road_name: string | null;
  direction_label: string | null;
  distance_meters: number | null;
  free_flow_time_seconds: number | null;
  /** `distance_meters / travel_time_seconds` in km/h; null without a link. */
  implied_speed_kph: number | null;
  hop_status: HopStatus;
  /** `camera_links.path`; null when there is no link to draw. */
  path: LineStringGeometry | null;
}

/**
 * A contiguous run of sightings — one trip.
 *
 * A plate's full history is not one route. Between trips there are gaps of hours
 * where the vehicle was parked, and joining those into a single path produces
 * absurd figures (a 20-hour "traversal" of a 1.4 km link) and invites an operator
 * to read a journey that never happened. The endpoint therefore splits the
 * timeline into segments and only emits hops *within* a segment.
 */
export interface TrajectorySegment {
  segment_index: number;
  started_at: string;
  ended_at: string;
  /** Accepted sightings in this trip, in time order. */
  sighting_ids: string[];
  /** Sum of the segment's hop distances; only monitored links contribute. */
  distance_meters: number;
  duration_seconds: number;
  average_speed_kph: number | null;
  camera_codes: string[];
}

export interface TrajectorySummary {
  sighting_count: number;
  accepted_count: number;
  excluded_count: number;
  distinct_camera_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  /** Distance across all segments, monitored links only. */
  total_distance_meters: number;
  /** Time actually spent travelling — the sum of segment durations, not
   *  last_seen minus first_seen, which would include the gaps between trips. */
  total_duration_seconds: number;
  average_speed_kph: number | null;
  anomaly_hop_count: number;
  unmonitored_hop_count: number;
  segment_count: number;
}

/**
 * `GET /plates/{plate}/trajectory`
 *
 * `sightings` holds the accepted, time-ordered passes that form the route.
 * Non-accepted sightings are returned separately so the operator can see what
 * was withheld and why, rather than silently losing data.
 */
export interface TrajectoryResponse {
  plate: { plate_id: string | null; normalized_plate: string };
  window: { from: string | null; to: string | null };
  sightings: Sighting[];
  excluded_sightings: Sighting[];
  /** Hops within segments only — never across a trip break. */
  hops: TrajectoryHop[];
  /** Contiguous trips, newest last. Always at least one when `sightings` is non-empty. */
  segments: TrajectorySegment[];
  summary: TrajectorySummary;
}

/** `GET /plates/search?q=` — typeahead for the plate search box. */
export interface PlateSuggestion {
  plate_id: string;
  normalized_plate: string;
  sighting_count: number;
  last_seen_at: string | null;
  is_blacklisted: boolean;
}

/* ---------------------------------------------------------------- sightings - */

export interface SightingsQuery {
  camera_code?: string;
  plate?: string;
  validation_status?: ValidationStatus[];
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/* ----------------------------------------------------------------- alerts -- */

export interface AlertsQuery {
  alert_type?: AlertType[];
  status?: AlertStatus[];
  severity?: Severity[];
  anomaly_reason?: AnomalyReason[];
  plate?: string;
  camera_code?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AcknowledgeAlertRequest {
  /** Written to `alerts.acknowledged_by`; also the `audit_logs.user_subject`. */
  acknowledged_by: string;
  resolution_notes?: string;
  /** `acknowledged` keeps it open for follow-up; `resolved` closes it. */
  status?: Extract<AlertStatus, 'acknowledged' | 'resolved'>;
}

/** Counts for the dock's filter chips, independent of the current page. */
export interface AlertCounts {
  total: number;
  new: number;
  acknowledged: number;
  resolved: number;
  blacklist: number;
  route_anomaly: number;
  by_severity: Record<Severity, number>;
  by_anomaly_reason: Record<AnomalyReason, number>;
}

/* -------------------------------------------------------------- blacklist -- */

export interface BlacklistQuery {
  status?: BlacklistStatus[];
  severity?: Severity[];
  q?: string;
  limit?: number;
  offset?: number;
}

export interface CreateBlacklistEntryRequest {
  /** Free text; the API normalises and resolves-or-creates the `plates` row. */
  plate: string;
  reason: string;
  severity: Severity;
  active_from?: string;
  active_until?: string | null;
  added_by: string;
  case_reference?: string | null;
}

export interface UpdateBlacklistEntryRequest {
  status?: BlacklistStatus;
  severity?: Severity;
  reason?: string;
  active_until?: string | null;
}

/* -------------------------------------------------------------- analytics -- */

export interface AnalyticsWindowQuery {
  from: string;
  to: string;
}

/** `GET /analytics/nodes` */
export interface NodeMetricsResponse {
  window: AnalyticsWindowQuery;
  nodes: NodeMetric[];
  /** Largest `vehicle_count` across nodes — the heatmap normaliser. */
  max_vehicle_count: number;
}

/** `GET /analytics/links` — congestion overlay + derived speed table. */
export interface LinkCongestionResponse {
  window: AnalyticsWindowQuery;
  links: LinkCongestion[];
  network_avg_congestion_score: number | null;
}

export type FlowTrendScope = 'network' | 'camera' | 'link';

export interface FlowTrendQuery extends AnalyticsWindowQuery {
  scope: FlowTrendScope;
  /** `camera_code` for scope=camera, `camera_link_id` for scope=link. */
  target_id?: string;
  /** Roll 5-minute rows up to this bucket size. 5 | 15 | 30 | 60. */
  bucket_minutes?: number;
}

/** `GET /analytics/flow-trends` */
export interface FlowTrendResponse {
  window: AnalyticsWindowQuery;
  scope: FlowTrendScope;
  target_id: string | null;
  target_label: string;
  bucket_minutes: number;
  points: FlowTrendPoint[];
}

/** `GET /analytics/origin-destination` */
export interface OriginDestinationResponse {
  window: AnalyticsWindowQuery;
  /** Axis order for the matrix. */
  camera_codes: string[];
  pairs: OriginDestinationPair[];
  total_journeys: number;
}

/** `GET /analytics/reports` */
export interface ReportQuery {
  granularity: ReportGranularity;
  /** ISO week (`2026-W35`) or month (`2026-08`). Defaults to the latest. */
  period?: string;
}

export interface ReportListResponse {
  /** Selectable periods, newest first. */
  periods: { granularity: ReportGranularity; label: string; period: string }[];
}

export type ReportResponse = CongestionReport;

/* ------------------------------------------------------------------- live -- */

/**
 * WebSocket envelope on `/ws/live`. Every frame is JSON with a `type`
 * discriminant, so the client can switch exhaustively.
 *
 * `hello` arrives once on connect and carries the server's schema version, so a
 * mismatched client can warn instead of misrendering.
 */
export type LiveMessage =
  | { type: 'hello'; schema_version: 1; server_time: string; subscriber_count?: number }
  | { type: 'heartbeat'; server_time: string }
  | { type: 'alert'; alert: Alert }
  | { type: 'sighting'; sighting: LiveSighting }
  | {
      type: 'alert_ack';
      alert_id: string;
      status: AlertStatus;
      acknowledged_by: string;
      acknowledged_at: string;
    };

/**
 * Trimmed sighting for the live ticker. Deliberately smaller than `Sighting` —
 * this frame can arrive many times a second.
 */
export interface LiveSighting {
  sighting_id: string;
  camera_code: string;
  camera_display_name: string;
  camera_location: [number, number];
  normalized_plate: string | null;
  spotted_at: string;
  validation_status: ValidationStatus;
  ocr_confidence: number | null;
  vehicle_type: string | null;
}

/** Client → server frames. Kept minimal: topic subscription only. */
export type LiveClientMessage =
  | { type: 'subscribe'; topics: LiveTopic[] }
  | { type: 'ping' };

export const LIVE_TOPICS = ['alerts', 'sightings'] as const;
export type LiveTopic = (typeof LIVE_TOPICS)[number];

export type ConnectionState =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'
  | 'mock';
