/**
 * Turning an `alerts` row into something an operator can act on in one glance.
 *
 * The schema stores the *evidence* (`details` jsonb, the two sighting ids, the
 * link id); it does not store a human explanation. Composing that explanation is
 * the dashboard's job, and doing it in one place keeps the dock, the alerts page
 * and the map popup telling the same story.
 */

import { formatDistance, formatSpeed } from '@/lib/geo';
import { formatConfidence } from '@/lib/congestion';
import { formatDuration } from '@/lib/time';
import type { BadgeTone } from '@/components/ui';
import type { Alert, AnomalyReason } from '@/types/domain';

export const ANOMALY_REASON_LABEL: Record<AnomalyReason, string> = {
  impossible_travel_time: 'Impossible travel time',
  wrong_direction: 'Wrong direction',
  suspected_clone: 'Suspected clone',
};

/** One-line explanation of what each anomaly actually means. */
export const ANOMALY_REASON_EXPLANATION: Record<AnomalyReason, string> = {
  impossible_travel_time:
    'The vehicle covered a monitored link faster than physically possible, which usually means a misread plate, a cloned plate, or a clock problem — not a fast driver.',
  wrong_direction:
    'The recorded heading contradicts the direction of the carriageway the vehicle must have travelled.',
  suspected_clone:
    'The same plate was recorded in two places too far apart for any route to explain, suggesting two vehicles carry it.',
};

export function alertTitle(alert: Alert): string {
  if (alert.alert_type === 'blacklist') return 'Blacklist match';
  return alert.anomaly_reason
    ? ANOMALY_REASON_LABEL[alert.anomaly_reason]
    : 'Route anomaly';
}

export function alertTone(alert: Alert): BadgeTone {
  if (alert.alert_type === 'route_anomaly') return 'violet';
  switch (alert.severity) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'danger';
    case 'medium':
      return 'warn';
    case 'low':
      return 'info';
    default:
      return 'neutral';
  }
}

/** Modifier for the card's coloured left edge. */
export function alertAccent(alert: Alert): string {
  if (alert.alert_type === 'route_anomaly') return 'anomaly';
  return alert.severity ?? 'low';
}

export const ALERT_STATUS_TONE: Record<Alert['status'], BadgeTone> = {
  new: 'danger',
  delivered: 'warn',
  acknowledged: 'info',
  resolved: 'ok',
};

/**
 * The sentence under the plate. Prefers the blacklist reason for a blacklist hit
 * (that is the actionable fact), and the anomaly note otherwise.
 */
export function alertReason(alert: Alert): string {
  if (alert.alert_type === 'blacklist') {
    return alert.blacklist_reason ?? 'Matched an active blacklist entry.';
  }
  if (typeof alert.details.note === 'string') return alert.details.note;
  return alert.anomaly_reason
    ? ANOMALY_REASON_EXPLANATION[alert.anomaly_reason]
    : 'Route anomaly detected.';
}

export interface AlertFigure {
  label: string;
  value: string;
  /** Renders in the danger colour — the number that proves the anomaly. */
  bad?: boolean;
}

/**
 * The handful of numbers that justify the alert, pulled out of `details`.
 * Deliberately shows the observed value *next to* the threshold it broke; a lone
 * "45 s" tells an operator nothing without the 90 s minimum beside it.
 */
export function alertFigures(alert: Alert): AlertFigure[] {
  const details = alert.details;
  const figures: AlertFigure[] = [];

  if (alert.alert_type === 'blacklist') {
    if (alert.severity) figures.push({ label: 'Severity', value: alert.severity });
    if (alert.case_reference) figures.push({ label: 'Case', value: alert.case_reference });
    if (alert.match_confidence !== null) {
      figures.push({
        label: 'OCR confidence',
        value: formatConfidence(alert.match_confidence),
        bad: alert.match_confidence < 0.8,
      });
    }
    return figures;
  }

  switch (alert.anomaly_reason) {
    case 'impossible_travel_time': {
      if (typeof details.observed_travel_time_seconds === 'number') {
        figures.push({
          label: 'Observed transit',
          value: formatDuration(details.observed_travel_time_seconds),
          bad: true,
        });
      }
      if (typeof details.minimum_travel_time_seconds === 'number') {
        figures.push({
          label: 'Physical minimum',
          value: formatDuration(details.minimum_travel_time_seconds),
        });
      }
      if (typeof details.implied_speed_kph === 'number') {
        figures.push({
          label: 'Implied speed',
          value: formatSpeed(details.implied_speed_kph),
          bad: true,
        });
      }
      if (typeof details.distance_meters === 'number') {
        figures.push({
          label: 'Link distance',
          value: formatDistance(details.distance_meters),
        });
      }
      break;
    }
    case 'wrong_direction': {
      if (typeof details.expected_direction_label === 'string') {
        figures.push({ label: 'Carriageway', value: details.expected_direction_label });
      }
      if (typeof details.observed_direction_degrees === 'number') {
        figures.push({
          label: 'Observed heading',
          value: `${Math.round(details.observed_direction_degrees)}°`,
          bad: true,
        });
      }
      break;
    }
    case 'suspected_clone': {
      if (Array.isArray(details.concurrent_camera_codes)) {
        figures.push({
          label: 'Cameras',
          value: details.concurrent_camera_codes.join(' + '),
        });
      }
      if (typeof details.separation_seconds === 'number') {
        figures.push({
          label: 'Time apart',
          value: formatDuration(details.separation_seconds),
          bad: true,
        });
      }
      if (typeof details.distance_meters === 'number') {
        figures.push({
          label: 'Straight-line gap',
          value: formatDistance(details.distance_meters),
        });
      }
      break;
    }
    default:
      break;
  }

  if (alert.match_confidence !== null) {
    figures.push({
      label: 'Match confidence',
      value: formatConfidence(alert.match_confidence),
      bad: alert.match_confidence < 0.8,
    });
  }

  return figures;
}

/** Whether the alert still needs an operator decision. */
export function isOpen(alert: Alert): boolean {
  return alert.status === 'new' || alert.status === 'delivered';
}
