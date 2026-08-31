/**
 * Simulated live feed.
 *
 * Rather than replaying a canned list, this mints genuinely new rows and ingests
 * them into the dataset. A sighting that scrolls past in the ticker is a real row
 * afterwards: it shows up in `/sightings`, it counts towards the camera's
 * `last_seen_at`, and an alert raised from it can be acknowledged and will stay
 * acknowledged. That is what makes the mock useful for finding bugs instead of
 * just filling space.
 *
 * Cadence is deliberately demo-friendly: a sighting every second or so, an alert
 * every half-minute — frequent enough to look alive, slow enough to read.
 */

import { bearingDegrees } from '@/lib/geo';
import { hashUnit, stableUuid } from '@/lib/rng';
import type { ConnectionState, LiveMessage, LiveSighting } from '@/types/api';
import type { Alert, AnomalyReason, Sighting } from '@/types/domain';
import type { LiveConnection } from '../live-types';
import { captureRate } from './seed/demand';
import { cameraByCode, dataset, findLink } from './seed';
import { buildSighting } from './seed/sighting-factory';
import { activeBlacklistByPlate } from './seed/plates';
import { ingestLiveAlert, ingestLiveSighting } from './queries';

export type { LiveConnection };

/* ---------------------------------------------------------------- generation -- */

const activeCameraCodes = dataset.cameraCodes.filter((code) => captureRate(code) > 0);

let liveTrackCounter = 500_000;

function nextTrack(): number {
  liveTrackCounter += 1;
  return liveTrackCounter;
}

function pickCamera(seed: number): string {
  const index = Math.floor(seed * activeCameraCodes.length);
  return activeCameraCodes[Math.min(index, activeCameraCodes.length - 1)] ?? 'CAM-01';
}

/** Heading a vehicle would plausibly show at this camera. */
function plausibleHeading(cameraCode: string, seed: number): number | null {
  const camera = cameraByCode.get(cameraCode);
  if (!camera) return null;
  const outgoing = dataset.cameraLinks.features.filter(
    (f) => f.properties.from_camera_code === cameraCode,
  );
  const pick = outgoing[Math.floor(seed * outgoing.length)];
  if (!pick) return camera.properties.heading_degrees;
  const target = cameraByCode.get(pick.properties.to_camera_code);
  if (!target) return camera.properties.heading_degrees;
  return bearingDegrees(camera.geometry.coordinates, target.geometry.coordinates);
}

function randomPlate(seed: number): string {
  const pool = dataset.plates;
  const index = Math.floor(seed * pool.length);
  return pool[Math.min(index, pool.length - 1)]?.normalized_plate ?? 'KA01AB1234';
}

function mint(args: {
  plate: string;
  cameraCode: string;
  atMs: number;
  forceAccepted?: boolean;
}): Sighting {
  const sighting = buildSighting({
    plate: args.plate,
    cameraCode: args.cameraCode,
    atMs: args.atMs,
    trackIndex: nextTrack(),
    directionDegrees: plausibleHeading(args.cameraCode, Math.random()),
    nowMs: args.atMs,
    ...(args.forceAccepted ? { forceValidation: 'accepted' as const } : {}),
  });
  ingestLiveSighting(sighting);
  return sighting;
}

function toLiveSighting(sighting: Sighting): LiveSighting {
  return {
    sighting_id: sighting.sighting_id,
    camera_code: sighting.camera_code,
    camera_display_name: sighting.camera_display_name,
    camera_location: sighting.camera_location,
    normalized_plate: sighting.normalized_plate ?? sighting.normalized_plate_candidate,
    spotted_at: sighting.spotted_at,
    validation_status: sighting.validation_status,
    ocr_confidence: sighting.ocr_confidence,
    vehicle_type: sighting.vehicle_type,
  };
}

function baseAlertFields(sighting: Sighting, previous: Sighting | null) {
  return {
    sighting_id: sighting.sighting_id,
    previous_sighting_id: previous?.sighting_id ?? null,
    normalized_plate: sighting.normalized_plate,
    camera_code: sighting.camera_code,
    camera_display_name: sighting.camera_display_name,
    camera_location: sighting.camera_location,
    spotted_at: sighting.spotted_at,
    previous_camera_code: previous?.camera_code ?? null,
    previous_spotted_at: previous?.spotted_at ?? null,
    plate_crop_object_key: sighting.plate_crop_object_key,
    status: 'new' as const,
    created_at: new Date().toISOString(),
    delivered_at: new Date().toISOString(),
    acknowledged_at: null,
    acknowledged_by: null,
    resolution_notes: null,
  };
}

/** A blacklisted vehicle passes a camera. */
function generateBlacklistAlert(nowMs: number): Alert | null {
  const enforceable = [...activeBlacklistByPlate(dataset.blacklist, nowMs).values()];
  if (enforceable.length === 0) return null;

  const entry = enforceable[Math.floor(Math.random() * enforceable.length)]!;
  const cameraCode = pickCamera(Math.random());
  const sighting = mint({
    plate: entry.normalized_plate,
    cameraCode,
    atMs: nowMs,
    forceAccepted: true,
  });

  const bucket = Math.floor(nowMs / (10 * 60_000));
  const dedupKey = `blacklist:${entry.normalized_plate}:${cameraCode}:${bucket}`;

  return {
    alert_id: stableUuid(`alert:${dedupKey}`),
    dedup_key: dedupKey,
    alert_type: 'blacklist',
    blacklist_entry_id: entry.blacklist_entry_id,
    anomaly_reason: null,
    match_confidence: sighting.ocr_confidence,
    details: {
      note: `Live match against an active ${entry.severity} blacklist entry.`,
    },
    severity: entry.severity,
    blacklist_reason: entry.reason,
    case_reference: entry.case_reference,
    ...baseAlertFields(sighting, null),
  };
}

/** A route anomaly, independent of the blacklist. */
function generateAnomalyAlert(nowMs: number): Alert | null {
  const reasons: AnomalyReason[] = [
    'impossible_travel_time',
    'wrong_direction',
    'suspected_clone',
  ];
  const reason = reasons[Math.floor(Math.random() * reasons.length)]!;
  const plate = randomPlate(Math.random());

  if (reason === 'suspected_clone') {
    // Two cameras far enough apart that no route explains the gap.
    const first = pickCamera(Math.random());
    const second = activeCameraCodes.find((code) => code !== first && !findLink(first, code));
    if (!second) return null;

    const separation = 40 + Math.floor(Math.random() * 70);
    const previous = mint({
      plate,
      cameraCode: first,
      atMs: nowMs - separation * 1000,
      forceAccepted: true,
    });
    const current = mint({ plate, cameraCode: second, atMs: nowMs, forceAccepted: true });
    const dedupKey = `anomaly:suspected_clone:${plate}:${current.sighting_id}`;

    return {
      alert_id: stableUuid(`alert:${dedupKey}`),
      dedup_key: dedupKey,
      alert_type: 'route_anomaly',
      blacklist_entry_id: null,
      anomaly_reason: reason,
      match_confidence: Number((0.78 + Math.random() * 0.18).toFixed(4)),
      details: {
        concurrent_camera_codes: [first, second],
        separation_seconds: separation,
        note: 'Separation is too short for any route between these cameras.',
      },
      severity: null,
      blacklist_reason: null,
      case_reference: null,
      ...baseAlertFields(current, previous),
    };
  }

  // Both remaining reasons need a real monitored link to violate.
  const links = dataset.cameraLinks.features.filter(
    (f) =>
      captureRate(f.properties.from_camera_code) > 0 &&
      captureRate(f.properties.to_camera_code) > 0,
  );
  const link = links[Math.floor(Math.random() * links.length)];
  if (!link) return null;

  const { from_camera_code: fromCode, to_camera_code: toCode } = link.properties;
  const minimum = Math.round(link.properties.free_flow_time_seconds * 0.6);

  if (reason === 'impossible_travel_time') {
    const observed = Math.max(8, Math.round(minimum * (0.3 + Math.random() * 0.3)));
    const previous = mint({
      plate,
      cameraCode: fromCode,
      atMs: nowMs - observed * 1000,
      forceAccepted: true,
    });
    const current = mint({ plate, cameraCode: toCode, atMs: nowMs, forceAccepted: true });
    const dedupKey = `anomaly:impossible_travel_time:${plate}:${current.sighting_id}`;

    return {
      alert_id: stableUuid(`alert:${dedupKey}`),
      dedup_key: dedupKey,
      alert_type: 'route_anomaly',
      blacklist_entry_id: null,
      anomaly_reason: reason,
      match_confidence: Number((0.82 + Math.random() * 0.16).toFixed(4)),
      details: {
        observed_travel_time_seconds: observed,
        minimum_travel_time_seconds: minimum,
        free_flow_time_seconds: link.properties.free_flow_time_seconds,
        distance_meters: link.properties.distance_meters,
        implied_speed_kph: Number(
          ((link.properties.distance_meters / observed) * 3.6).toFixed(1),
        ),
        camera_link_id: link.properties.camera_link_id,
        note: 'Observed transit is below the physical minimum for this link.',
      },
      severity: null,
      blacklist_reason: null,
      case_reference: null,
      ...baseAlertFields(current, previous),
    };
  }

  const travel = Math.round(link.properties.free_flow_time_seconds * 1.1);
  const previous = mint({
    plate,
    cameraCode: fromCode,
    atMs: nowMs - travel * 1000,
    forceAccepted: true,
  });
  const current = mint({ plate, cameraCode: toCode, atMs: nowMs, forceAccepted: true });
  const forward = bearingDegrees(previous.camera_location, current.camera_location);
  const dedupKey = `anomaly:wrong_direction:${plate}:${current.sighting_id}`;

  return {
    alert_id: stableUuid(`alert:${dedupKey}`),
    dedup_key: dedupKey,
    alert_type: 'route_anomaly',
    blacklist_entry_id: null,
    anomaly_reason: 'wrong_direction',
    match_confidence: Number((0.7 + Math.random() * 0.22).toFixed(4)),
    details: {
      expected_direction_label: link.properties.direction_label ?? undefined,
      observed_direction_degrees: Number(((forward + 180) % 360).toFixed(1)),
      camera_link_id: link.properties.camera_link_id,
      note: 'Recorded heading opposes the monitored carriageway.',
    },
    severity: null,
    blacklist_reason: null,
    case_reference: null,
    ...baseAlertFields(current, previous),
  };
}

/* ---------------------------------------------------------------- connection -- */

const SIGHTING_INTERVAL = [700, 1900] as const;
const ALERT_INTERVAL = [22_000, 52_000] as const;
const HEARTBEAT_INTERVAL = 15_000;

function jitter([min, max]: readonly [number, number]): number {
  return min + Math.random() * (max - min);
}

export function createMockLiveConnection(): LiveConnection {
  const messageListeners = new Set<(message: LiveMessage) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  let closed = false;

  const emit = (message: LiveMessage) => {
    if (closed) return;
    for (const listener of messageListeners) listener(message);
  };

  // The mock has its own connection state so the UI can label the feed honestly
  // instead of claiming a live socket that isn't there.
  const state: ConnectionState = 'mock';

  const scheduleSighting = () => {
    const timer = setTimeout(() => {
      if (closed) return;
      const nowMs = Date.now();
      const camera = pickCamera(hashUnit('live', nowMs));
      const sighting = mint({ plate: randomPlate(Math.random()), cameraCode: camera, atMs: nowMs });
      emit({ type: 'sighting', sighting: toLiveSighting(sighting) });
      scheduleSighting();
    }, jitter(SIGHTING_INTERVAL));
    timers.push(timer);
  };

  const scheduleAlert = () => {
    const timer = setTimeout(() => {
      if (closed) return;
      const nowMs = Date.now();
      // Blacklist hits are the more common event in a real control room.
      const alert =
        Math.random() < 0.6 ? generateBlacklistAlert(nowMs) : generateAnomalyAlert(nowMs);
      if (alert) {
        ingestLiveAlert(alert);
        emit({ type: 'alert', alert });
      }
      scheduleAlert();
    }, jitter(ALERT_INTERVAL));
    timers.push(timer);
  };

  const heartbeat = setInterval(() => {
    emit({ type: 'heartbeat', server_time: new Date().toISOString() });
  }, HEARTBEAT_INTERVAL);

  // `hello` after a tick so subscribers registered synchronously still see it.
  const helloTimer = setTimeout(() => {
    emit({ type: 'hello', schema_version: 1, server_time: new Date().toISOString() });
    for (const listener of stateListeners) listener(state);
    scheduleSighting();
    scheduleAlert();
  }, 120);
  timers.push(helloTimer);

  return {
    getState: () => (closed ? 'closed' : state),
    onMessage: (listener) => {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onState: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    close: () => {
      closed = true;
      clearInterval(heartbeat);
      for (const timer of timers) clearTimeout(timer);
      messageListeners.clear();
      stateListeners.clear();
    },
  };
}
