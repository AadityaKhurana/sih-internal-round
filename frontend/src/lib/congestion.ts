/**
 * Congestion presentation rules — one place, so the map overlay, the tables, the
 * legend and the reports never disagree about what "heavy" means.
 *
 * `congestion_score` is the ratio
 * `median_travel_time_seconds / camera_links.free_flow_time_seconds`
 * (1.0 = free flow). See frontend/API_CONTRACT.md — if Lane B defines it
 * differently, only the thresholds below change.
 */

import type {
  CameraStatus,
  CongestionLevel,
  Severity,
  ValidationStatus,
} from '@/types/domain';
import type { HopStatus } from '@/types/api';
import type { BadgeTone } from '@/components/ui';

/* ----------------------------------------------------------- congestion ---- */

/** Lower bound of each bucket, ordered worst-first for a simple scan. */
const CONGESTION_THRESHOLDS: ReadonlyArray<readonly [CongestionLevel, number]> = [
  ['severe', 2.5],
  ['heavy', 1.8],
  ['moderate', 1.4],
  ['light', 1.15],
  ['free', 0],
];

export function congestionLevel(score: number | null | undefined): CongestionLevel {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'unknown';
  for (const [level, min] of CONGESTION_THRESHOLDS) {
    if (score >= min) return level;
  }
  return 'free';
}

const CONGESTION_VARS: Record<CongestionLevel, string> = {
  free: 'var(--c-congestion-free)',
  light: 'var(--c-congestion-light)',
  moderate: 'var(--c-congestion-moderate)',
  heavy: 'var(--c-congestion-heavy)',
  severe: 'var(--c-congestion-severe)',
  unknown: 'var(--c-congestion-unknown)',
};

/**
 * Literal hex per level. Leaflet path options are applied to SVG attributes that
 * do not resolve CSS custom properties, so the map needs concrete values while
 * the DOM uses the `var()` forms. Both are kept in step with tokens.css.
 */
const CONGESTION_HEX: Record<CongestionLevel, string> = {
  free: '#16a34a',
  light: '#65a30d',
  moderate: '#ca8a04',
  heavy: '#ea580c',
  severe: '#dc2626',
  unknown: '#94a3b8',
};

export function congestionColorVar(level: CongestionLevel): string {
  return CONGESTION_VARS[level];
}

export function congestionColorHex(level: CongestionLevel): string {
  return CONGESTION_HEX[level];
}

export const CONGESTION_LABELS: Record<CongestionLevel, string> = {
  free: 'Free flow',
  light: 'Light',
  moderate: 'Moderate',
  heavy: 'Heavy',
  severe: 'Severe',
  unknown: 'No data',
};

/** Range description for the legend, e.g. `1.4–1.8× free flow`. */
export const CONGESTION_RANGES: Record<CongestionLevel, string> = {
  free: '< 1.15× free flow',
  light: '1.15–1.4×',
  moderate: '1.4–1.8×',
  heavy: '1.8–2.5×',
  severe: '≥ 2.5× free flow',
  unknown: 'no matched journeys',
};

export const CONGESTION_LEGEND = (
  ['free', 'light', 'moderate', 'heavy', 'severe', 'unknown'] as const
).map((level) => ({
  color: congestionColorHex(level),
  label: `${CONGESTION_LABELS[level]} — ${CONGESTION_RANGES[level]}`,
  line: true,
}));

/**
 * A congestion figure computed from very few matched journeys is noise. The UI
 * labels anything under this threshold as low confidence rather than hiding it.
 */
export const LOW_SAMPLE_THRESHOLD = 5;

export function isLowSample(sampleCount: number): boolean {
  return sampleCount < LOW_SAMPLE_THRESHOLD;
}

/* --------------------------------------------------------------- statuses -- */

export const CAMERA_STATUS_TONE: Record<CameraStatus, BadgeTone> = {
  active: 'ok',
  inactive: 'neutral',
  maintenance: 'warn',
  fault: 'danger',
};

export const CAMERA_STATUS_HEX: Record<CameraStatus, string> = {
  active: '#16a34a',
  inactive: '#94a3b8',
  maintenance: '#d97706',
  fault: '#dc2626',
};

export const VALIDATION_TONE: Record<ValidationStatus, BadgeTone> = {
  accepted: 'ok',
  pending: 'neutral',
  uncertain: 'warn',
  conflict: 'danger',
};

export const VALIDATION_LABEL: Record<ValidationStatus, string> = {
  accepted: 'Accepted',
  pending: 'Pending',
  uncertain: 'Uncertain',
  conflict: 'Conflict',
};

export const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  low: 'info',
  medium: 'warn',
  high: 'danger',
  critical: 'critical',
};

export const SEVERITY_HEX: Record<Severity, string> = {
  low: '#2563eb',
  medium: '#d97706',
  high: '#dc2626',
  critical: '#be123c',
};

/** Severity ordering for "worst first" sorts. */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/* ------------------------------------------------------------ hop statuses -- */

export const HOP_STATUS_LABEL: Record<HopStatus, string> = {
  valid: 'Validated link',
  no_link: 'No monitored link',
  impossible_travel_time: 'Impossible travel time',
  wrong_direction: 'Wrong direction',
};

export const HOP_STATUS_TONE: Record<HopStatus, BadgeTone> = {
  valid: 'ok',
  no_link: 'neutral',
  impossible_travel_time: 'danger',
  wrong_direction: 'warn',
};

export const HOP_STATUS_HEX: Record<HopStatus, string> = {
  valid: '#9333ea',
  no_link: '#94a3b8',
  impossible_travel_time: '#dc2626',
  wrong_direction: '#d97706',
};

/* ------------------------------------------------------------ misc format -- */

/** Confidence 0–1 → `91%`. */
export function formatConfidence(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

export function formatScore(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString();
}

export function formatPercentDelta(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}
