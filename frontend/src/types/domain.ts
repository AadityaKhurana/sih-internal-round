/**
 * Domain types mirroring `db/schema.sql` and the `PlateSighting` contract in
 * `common/anpr_common/events.py`.
 *
 * Rules for this file:
 *  - Field names match the SQL columns exactly (snake_case) so a row can be
 *    serialised straight to JSON with no rename layer in the API.
 *  - `timestamptz` becomes an RFC 3339 string; `numeric` becomes `number`;
 *    `uuid` becomes `string`.
 *  - Every CHECK-constrained text column becomes a string-literal union, so the
 *    compiler catches a status the UI has no styling for.
 */

import type { LineStringGeometry } from './geo';

/* ---------------------------------------------------------------- enums ---- */

/** `cameras.status` */
export const CAMERA_STATUSES = ['active', 'inactive', 'maintenance', 'fault'] as const;
export type CameraStatus = (typeof CAMERA_STATUSES)[number];

/** `sightings.validation_status` */
export const VALIDATION_STATUSES = [
  'pending',
  'accepted',
  'uncertain',
  'conflict',
] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

/** `alerts.alert_type` */
export const ALERT_TYPES = ['blacklist', 'route_anomaly'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** `alerts.anomaly_reason` */
export const ANOMALY_REASONS = [
  'impossible_travel_time',
  'wrong_direction',
  'suspected_clone',
] as const;
export type AnomalyReason = (typeof ANOMALY_REASONS)[number];

/** `alerts.status` */
export const ALERT_STATUSES = ['new', 'delivered', 'acknowledged', 'resolved'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/** `blacklist_entries.severity` */
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** `blacklist_entries.status` */
export const BLACKLIST_STATUSES = ['active', 'inactive', 'expired'] as const;
export type BlacklistStatus = (typeof BLACKLIST_STATUSES)[number];

/**
 * Derived on the client from `congestion_score` (median / baseline travel time).
 * Not a DB column — purely a presentation bucket for the map ramp and legends.
 */
export const CONGESTION_LEVELS = [
  'free',
  'light',
  'moderate',
  'heavy',
  'severe',
  'unknown',
] as const;
export type CongestionLevel = (typeof CONGESTION_LEVELS)[number];

/* --------------------------------------------------------------- network --- */

/** `roads` */
export interface Road {
  road_id: string;
  road_code: string;
  name: string;
  active: boolean;
}

/**
 * `cameras`, minus `location` (carried as the GeoJSON Feature's geometry) and
 * minus `stream_uri_ref` (never sent to the browser — it is an internal ref).
 */
export interface CameraProperties {
  camera_id: string;
  camera_code: string;
  display_name: string;
  /** `cameras.heading_degrees` — the direction the camera faces, 0–360. */
  heading_degrees: number | null;
  status: CameraStatus;
  last_seen_at: string | null;
  /** Denormalised for tooltips; joined via the links that touch this camera. */
  road_names?: string[];
}

/** `camera_links`, minus `path` (carried as the Feature geometry). */
export interface CameraLinkProperties {
  camera_link_id: string;
  from_camera_id: string;
  to_camera_id: string;
  /** Denormalised so the map can label a link without a second request. */
  from_camera_code: string;
  to_camera_code: string;
  road_id: string | null;
  road_name: string | null;
  direction_label: string | null;
  distance_meters: number;
  free_flow_time_seconds: number;
  speed_limit_kph: number | null;
  active: boolean;
}

/* -------------------------------------------------------------- sightings -- */

/** One entry of `sightings.ocr_candidates` jsonb; mirrors `OcrCandidate`. */
export interface OcrCandidate {
  plate: string;
  confidence: number;
}

/**
 * `sightings.quality_flags` jsonb. Deliberately open-ended — the OCR worker may
 * add flags without a frontend change; known keys get first-class rendering.
 */
export interface QualityFlags {
  night?: boolean;
  motion_blur?: boolean;
  angled?: boolean;
  occluded?: boolean;
  dirty_plate?: boolean;
  [key: string]: boolean | undefined;
}

/** `plates` */
export interface Plate {
  plate_id: string;
  normalized_plate: string;
}

/**
 * A `sightings` row joined to its camera. `plate_id` is nullable in the schema
 * (identity unresolved), so it stays nullable here.
 */
export interface Sighting {
  sighting_id: string;
  source_event_id: string;
  camera_id: string;
  camera_code: string;
  camera_display_name: string;
  /** Camera location, GeoJSON order `[lng, lat]`. */
  camera_location: [number, number];
  plate_id: string | null;
  normalized_plate: string | null;
  raw_plate_text: string | null;
  normalized_plate_candidate: string | null;
  camera_track_id: string | null;
  detection_confidence: number | null;
  ocr_confidence: number | null;
  ocr_candidates: OcrCandidate[];
  validation_status: ValidationStatus;
  validation_reason: string | null;
  spotted_at: string;
  processed_at: string;
  direction_degrees: number | null;
  vehicle_type: string | null;
  vehicle_color: string | null;
  lane_number: number | null;
  quality_flags: QualityFlags;
  model_version: string | null;
  plate_crop_object_key: string | null;
  vehicle_image_object_key: string | null;
  context_clip_object_key: string | null;
}

/* ------------------------------------------------------------- blacklist --- */

/** `blacklist_entries` joined to `plates`. */
export interface BlacklistEntry {
  blacklist_entry_id: string;
  plate_id: string;
  normalized_plate: string;
  reason: string;
  severity: Severity;
  status: BlacklistStatus;
  active_from: string;
  active_until: string | null;
  added_by: string | null;
  case_reference: string | null;
  /** Convenience aggregates so the management table needs one request. */
  sighting_count?: number;
  last_seen_at?: string | null;
}

/* ----------------------------------------------------------------- alerts -- */

/**
 * `alerts` with the joins an operator needs to triage without a second call:
 * the triggering sighting, the plate, and (for anomalies) the previous sighting
 * plus the link that was violated.
 */
export interface Alert {
  alert_id: string;
  dedup_key: string;
  alert_type: AlertType;
  sighting_id: string;
  previous_sighting_id: string | null;
  blacklist_entry_id: string | null;
  anomaly_reason: AnomalyReason | null;
  match_confidence: number | null;
  status: AlertStatus;
  details: AlertDetails;
  created_at: string;
  delivered_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolution_notes: string | null;

  /* --- joined, read-only --- */
  normalized_plate: string | null;
  camera_code: string;
  camera_display_name: string;
  camera_location: [number, number];
  spotted_at: string;
  /** From `blacklist_entries` when `alert_type = 'blacklist'`. */
  severity: Severity | null;
  blacklist_reason: string | null;
  case_reference: string | null;
  /** Previous camera for a route anomaly. */
  previous_camera_code: string | null;
  previous_spotted_at: string | null;
  plate_crop_object_key: string | null;
}

/**
 * `alerts.details` jsonb. Shape depends on `anomaly_reason`; all fields optional
 * so an added key never breaks parsing.
 */
export interface AlertDetails {
  /** impossible_travel_time */
  observed_travel_time_seconds?: number;
  minimum_travel_time_seconds?: number;
  free_flow_time_seconds?: number;
  distance_meters?: number;
  implied_speed_kph?: number;
  /** wrong_direction */
  expected_direction_label?: string;
  observed_direction_degrees?: number;
  /** suspected_clone */
  concurrent_camera_codes?: string[];
  separation_seconds?: number;
  camera_link_id?: string;
  note?: string;
  [key: string]: unknown;
}

/* -------------------------------------------------------------- analytics -- */

/** `camera_metrics_5m` aggregated over a query window, joined to the camera. */
export interface NodeMetric {
  camera_id: string;
  camera_code: string;
  display_name: string;
  status: CameraStatus;
  /** GeoJSON order `[lng, lat]`. */
  location: [number, number];
  vehicle_count: number;
  unique_plate_count: number;
  /** Highest single 5-minute `vehicle_count` inside the window. */
  peak_5m_vehicle_count: number;
  /** True if any window in the range was flagged `significant_change`. */
  significant_change: boolean;
  /** Percent change against the window-of-week baseline; null when unknown. */
  vs_baseline_pct: number | null;
}

/** `traffic_metrics_5m` aggregated over a window, joined to `camera_links`. */
export interface LinkCongestion {
  camera_link_id: string;
  from_camera_id: string;
  to_camera_id: string;
  from_camera_code: string;
  to_camera_code: string;
  road_name: string | null;
  direction_label: string | null;
  distance_meters: number;
  free_flow_time_seconds: number;
  speed_limit_kph: number | null;
  vehicle_count: number;
  unique_vehicle_count: number;
  median_travel_time_seconds: number | null;
  baseline_travel_time_seconds: number | null;
  baseline_vehicle_count: number | null;
  congestion_score: number | null;
  /** Journeys matched at BOTH ends of the link — the reliability signal. */
  travel_time_sample_count: number;
  significant_change: boolean;
  /**
   * `distance_meters / median_travel_time_seconds`, converted to km/h.
   * Derived on read per the schema note (no stored average_speed_kph).
   */
  derived_speed_kph: number | null;
  /** Link geometry so the overlay can draw without joining /camera-links. */
  path: LineStringGeometry | null;
}

/** One bucket of a flow trend series. */
export interface FlowTrendPoint {
  window_start: string;
  vehicle_count: number;
  unique_vehicle_count: number;
  median_travel_time_seconds: number | null;
  congestion_score: number | null;
  baseline_vehicle_count: number | null;
}

/** One origin→destination cell. Journeys are matched plate passes, not links. */
export interface OriginDestinationPair {
  from_camera_id: string;
  to_camera_id: string;
  from_camera_code: string;
  to_camera_code: string;
  journey_count: number;
  median_travel_time_seconds: number | null;
  /** Share of all journeys originating at `from_camera_code`. */
  share_pct: number;
}

/* ---------------------------------------------------------------- reports -- */

export type ReportGranularity = 'week' | 'month';

export interface ReportPeriod {
  granularity: ReportGranularity;
  /** Human label, e.g. '2026-W35' or 'August 2026'. */
  label: string;
  from: string;
  to: string;
}

export interface ReportSummary {
  total_sightings: number;
  unique_plates: number;
  avg_congestion_score: number | null;
  peak_congestion_score: number | null;
  busiest_camera_code: string | null;
  worst_link_label: string | null;
  alert_count: number;
  /** Sum of (median − baseline) travel time over all matched journeys, in hours. */
  total_delay_hours: number | null;
}

export interface ReportComparison {
  previous_label: string;
  congestion_delta_pct: number | null;
  volume_delta_pct: number | null;
}

/** One cell of the day-of-week × hour congestion grid. */
export interface HourlyProfileCell {
  /** 0 = Monday … 6 = Sunday. */
  day_of_week: number;
  hour: number;
  congestion_score: number | null;
  vehicle_count: number;
}

export interface DailySeriesPoint {
  date: string;
  vehicle_count: number;
  avg_congestion_score: number | null;
  baseline_vehicle_count: number | null;
}

export interface AlertBreakdown {
  alert_type: AlertType;
  anomaly_reason: AnomalyReason | null;
  count: number;
}

export interface CongestionReport {
  period: ReportPeriod;
  summary: ReportSummary;
  comparison: ReportComparison | null;
  worst_links: LinkCongestion[];
  hourly_profile: HourlyProfileCell[];
  daily_series: DailySeriesPoint[];
  alerts_by_type: AlertBreakdown[];
}
