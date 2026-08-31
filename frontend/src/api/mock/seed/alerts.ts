/**
 * Alert fixtures — both kinds the schema supports, produced independently.
 *
 * Blacklist alerts come from matching accepted sightings against enforceable
 * `blacklist_entries`. Route-anomaly alerts come from the scripted scenarios in
 * `journeys.ts` plus a deterministic sample of background journeys, and never
 * reference a blacklist entry. That mirrors the schema's shape guards: a
 * blacklist alert must cite an entry, an anomaly alert must cite a reason.
 *
 * `dedup_key` format used here (the schema requires uniqueness but fixes no
 * format — see frontend/API_CONTRACT.md):
 *   blacklist:<plate>:<camera_code>:<10-minute bucket epoch>
 *   anomaly:<reason>:<plate>:<sighting_id>
 */

import { hashUnit, stableUuid } from '@/lib/rng';
import { haversineMeters, speedKph } from '@/lib/geo';
import type { Alert, AlertDetails, AnomalyReason, BlacklistEntry, Sighting } from '@/types/domain';
import { DATASET_NOW } from './clock';
import { generatedJourneys, generatedSightings, scenarioMarkers } from './journeys';
import { findLink } from './network';
import { activeBlacklistByPlate, blacklistSeedEntries } from './plates';

const sightingById = new Map(generatedSightings.map((s) => [s.sighting_id, s]));

/** Shared join fields every alert carries, taken from the triggering sighting. */
function joinFields(sighting: Sighting, previous: Sighting | null) {
  return {
    normalized_plate: sighting.normalized_plate,
    camera_code: sighting.camera_code,
    camera_display_name: sighting.camera_display_name,
    camera_location: sighting.camera_location,
    spotted_at: sighting.spotted_at,
    previous_camera_code: previous?.camera_code ?? null,
    previous_spotted_at: previous?.spotted_at ?? null,
    plate_crop_object_key: sighting.plate_crop_object_key,
  };
}

/**
 * Lifecycle by age: anything in the last ~12 minutes is still `new`, then
 * `delivered`, then triaged. Gives the dock a realistic mix on first load
 * instead of a wall of identical rows.
 */
function lifecycle(
  createdMs: number,
  seedKey: string,
): Pick<Alert, 'status' | 'delivered_at' | 'acknowledged_at' | 'acknowledged_by' | 'resolution_notes'> {
  const ageMinutes = (DATASET_NOW - createdMs) / 60_000;
  const deliveredAt = new Date(createdMs + 700 + hashUnit(seedKey, 'dl') * 1800).toISOString();

  if (ageMinutes < 12) {
    return {
      status: 'new',
      delivered_at: deliveredAt,
      acknowledged_at: null,
      acknowledged_by: null,
      resolution_notes: null,
    };
  }

  if (ageMinutes < 45) {
    return {
      status: 'delivered',
      delivered_at: deliveredAt,
      acknowledged_at: null,
      acknowledged_by: null,
      resolution_notes: null,
    };
  }

  const roll = hashUnit(seedKey, 'lc');
  const operators = ['insp.rao', 'sub.insp.mehta', 'analyst.dcosta', 'control.room.1'];
  const operator = operators[Math.floor(hashUnit(seedKey, 'op') * operators.length)] ?? 'control.room.1';
  const ackMs = createdMs + (3 + hashUnit(seedKey, 'ackd') * 22) * 60_000;

  if (roll < 0.24) {
    return {
      status: 'delivered',
      delivered_at: deliveredAt,
      acknowledged_at: null,
      acknowledged_by: null,
      resolution_notes: null,
    };
  }

  if (roll < 0.7) {
    return {
      status: 'acknowledged',
      delivered_at: deliveredAt,
      acknowledged_at: new Date(ackMs).toISOString(),
      acknowledged_by: operator,
      resolution_notes: null,
    };
  }

  return {
    status: 'resolved',
    delivered_at: deliveredAt,
    acknowledged_at: new Date(ackMs).toISOString(),
    acknowledged_by: operator,
    resolution_notes:
      hashUnit(seedKey, 'note') < 0.5
        ? 'Patrol dispatched, vehicle intercepted and verified.'
        : 'Reviewed against evidence crop — no further action required.',
  };
}

/* ----------------------------------------------------------- blacklist hits -- */

const alerts: Alert[] = [];

function pushBlacklistAlert(sighting: Sighting, entry: BlacklistEntry): void {
  const createdMs = Date.parse(sighting.spotted_at) + 1200;
  const bucket = Math.floor(Date.parse(sighting.spotted_at) / (10 * 60_000));
  const dedupKey = `blacklist:${entry.normalized_plate}:${sighting.camera_code}:${bucket}`;
  const seedKey = `alert:${dedupKey}`;

  alerts.push({
    alert_id: stableUuid(seedKey),
    dedup_key: dedupKey,
    alert_type: 'blacklist',
    sighting_id: sighting.sighting_id,
    previous_sighting_id: null,
    blacklist_entry_id: entry.blacklist_entry_id,
    anomaly_reason: null,
    match_confidence: sighting.ocr_confidence,
    details: {
      note: `Accepted sighting matched an active ${entry.severity} blacklist entry.`,
      case_reference: entry.case_reference ?? undefined,
    },
    created_at: new Date(createdMs).toISOString(),
    severity: entry.severity,
    blacklist_reason: entry.reason,
    case_reference: entry.case_reference,
    ...joinFields(sighting, null),
    ...lifecycle(createdMs, seedKey),
  });
}

const seenDedupKeys = new Set<string>();

for (const sighting of generatedSightings) {
  if (sighting.validation_status !== 'accepted' || !sighting.normalized_plate) continue;

  const spottedMs = Date.parse(sighting.spotted_at);
  const entry = activeBlacklistByPlate(blacklistSeedEntries, spottedMs).get(
    sighting.normalized_plate,
  );
  if (!entry) continue;

  const bucket = Math.floor(spottedMs / (10 * 60_000));
  const dedupKey = `blacklist:${entry.normalized_plate}:${sighting.camera_code}:${bucket}`;
  if (seenDedupKeys.has(dedupKey)) continue;
  seenDedupKeys.add(dedupKey);

  pushBlacklistAlert(sighting, entry);
}

/* ---------------------------------------------------------- route anomalies -- */

function pushAnomalyAlert(args: {
  reason: AnomalyReason;
  sighting: Sighting;
  previous: Sighting | null;
  cameraLinkId: string | null;
  matchConfidence: number;
  details: AlertDetails;
}): void {
  const plate = args.sighting.normalized_plate ?? args.sighting.normalized_plate_candidate ?? 'UNKNOWN';
  const dedupKey = `anomaly:${args.reason}:${plate}:${args.sighting.sighting_id}`;
  if (seenDedupKeys.has(dedupKey)) return;
  seenDedupKeys.add(dedupKey);

  const createdMs = Date.parse(args.sighting.spotted_at) + 2400;
  const seedKey = `alert:${dedupKey}`;

  alerts.push({
    alert_id: stableUuid(seedKey),
    dedup_key: dedupKey,
    alert_type: 'route_anomaly',
    sighting_id: args.sighting.sighting_id,
    previous_sighting_id: args.previous?.sighting_id ?? null,
    // Anomaly alerts are independent of the blacklist, per the schema.
    blacklist_entry_id: null,
    anomaly_reason: args.reason,
    match_confidence: args.matchConfidence,
    details: {
      ...(args.cameraLinkId ? { camera_link_id: args.cameraLinkId } : {}),
      ...args.details,
    },
    created_at: new Date(createdMs).toISOString(),
    severity: null,
    blacklist_reason: null,
    case_reference: null,
    ...joinFields(args.sighting, args.previous),
    ...lifecycle(createdMs, seedKey),
  });
}

/* Scripted scenarios first, so they always exist. */
for (const marker of scenarioMarkers) {
  const sighting = sightingById.get(marker.sighting_id);
  if (!sighting) continue;
  const previous = marker.previous_sighting_id
    ? sightingById.get(marker.previous_sighting_id) ?? null
    : null;

  pushAnomalyAlert({
    reason: marker.anomaly_reason,
    sighting,
    previous,
    cameraLinkId: marker.camera_link_id,
    matchConfidence: marker.match_confidence,
    details: { ...marker.details, note: marker.details.note ?? marker.label },
  });
}

/* A deterministic sample of background journeys also trips the anomaly rules,
   so the alert list, the filters and the weekly report have real volume. */
const ANOMALY_REASONS_WEIGHTED: readonly AnomalyReason[] = [
  'impossible_travel_time',
  'impossible_travel_time',
  'wrong_direction',
  'suspected_clone',
];

for (const journey of generatedJourneys) {
  if (hashUnit('anomaly-pick', journey.journey_id) > 0.035) continue;
  if (journey.sighting_ids.length < 2) continue;

  const index = Math.floor(
    hashUnit('anomaly-idx', journey.journey_id) * (journey.sighting_ids.length - 1),
  );
  const previous = sightingById.get(journey.sighting_ids[index]!);
  const current = sightingById.get(journey.sighting_ids[index + 1]!);
  if (!previous || !current) continue;
  if (previous.validation_status !== 'accepted' || current.validation_status !== 'accepted') continue;

  const reason =
    ANOMALY_REASONS_WEIGHTED[
      Math.floor(hashUnit('anomaly-reason', journey.journey_id) * ANOMALY_REASONS_WEIGHTED.length)
    ] ?? 'impossible_travel_time';

  const link = findLink(previous.camera_code, current.camera_code);
  const observedSeconds = Math.round(
    (Date.parse(current.spotted_at) - Date.parse(previous.spotted_at)) / 1000,
  );
  const straightLine = haversineMeters(previous.camera_location, current.camera_location);

  if (reason === 'impossible_travel_time') {
    if (!link) continue;
    const distance = link.properties.distance_meters;
    const minimum = Math.round(link.properties.free_flow_time_seconds * 0.6);
    // Report the transit as faster than physically possible for this link.
    const claimed = Math.max(9, Math.round(minimum * (0.35 + hashUnit('itt', journey.journey_id) * 0.3)));
    pushAnomalyAlert({
      reason,
      sighting: current,
      previous,
      cameraLinkId: link.properties.camera_link_id,
      matchConfidence: Number((0.8 + hashUnit('conf', journey.journey_id) * 0.18).toFixed(4)),
      details: {
        observed_travel_time_seconds: claimed,
        minimum_travel_time_seconds: minimum,
        free_flow_time_seconds: link.properties.free_flow_time_seconds,
        distance_meters: distance,
        implied_speed_kph: Number((speedKph(distance, claimed) ?? 0).toFixed(1)),
        camera_link_id: link.properties.camera_link_id,
        note: 'Observed transit is below the physical minimum for this link.',
      },
    });
    continue;
  }

  if (reason === 'wrong_direction') {
    if (!link || current.direction_degrees === null) continue;
    pushAnomalyAlert({
      reason,
      sighting: current,
      previous,
      cameraLinkId: link.properties.camera_link_id,
      matchConfidence: Number((0.72 + hashUnit('conf', journey.journey_id) * 0.2).toFixed(4)),
      details: {
        expected_direction_label: link.properties.direction_label ?? undefined,
        observed_direction_degrees: Number(((current.direction_degrees + 174) % 360).toFixed(1)),
        camera_link_id: link.properties.camera_link_id,
        note: 'Recorded heading opposes the monitored carriageway.',
      },
    });
    continue;
  }

  pushAnomalyAlert({
    reason: 'suspected_clone',
    sighting: current,
    previous,
    cameraLinkId: null,
    matchConfidence: Number((0.76 + hashUnit('conf', journey.journey_id) * 0.2).toFixed(4)),
    details: {
      concurrent_camera_codes: [previous.camera_code, current.camera_code],
      separation_seconds: Math.max(20, Math.round(observedSeconds * 0.12)),
      distance_meters: Math.round(straightLine),
      note: 'Separation is too short for any route between these cameras.',
    },
  });
}

alerts.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

export const generatedAlerts: readonly Alert[] = alerts;
