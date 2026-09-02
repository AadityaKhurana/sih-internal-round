/**
 * Materialised sightings.
 *
 * Aggregate analytics come from the analytic demand model, but trajectory
 * playback, plate search, the live ticker and alerts all need real rows, so a few
 * days of individual vehicle passes are generated here.
 *
 * A journey is a walk across the `camera_links` graph: the vehicle is recorded at
 * each camera it passes, with travel times drawn from the same congestion model
 * that produces `traffic_metrics_5m`. Roughly one journey in twelve includes a
 * jump to a non-adjacent camera, representing a vehicle that used an unmonitored
 * road — that is what produces `no_link` hops in the trajectory view, and the
 * dashboard is expected to show them rather than pretend the network is complete.
 *
 * Four scenarios are scripted rather than left to chance, so a demo can be driven
 * to a known outcome: impossible travel time, wrong direction, suspected clone,
 * and contested OCR.
 */

import { createRng, hashUnit, stableUuid } from '@/lib/rng';
import { bearingDegrees } from '@/lib/geo';
import type { AlertDetails, AnomalyReason, Sighting } from '@/types/domain';
import { DATASET_NOW, SIGHTINGS_START } from './clock';
import { captureRate, demandWeight, sampleTravelTimeSeconds } from './demand';
import { cameraByCode, cameraCodes, findLink, outgoingLinks } from './network';
import { frequentPlates, plates, STORY_PLATES } from './plates';
import { buildSighting } from './sighting-factory';

const rng = createRng('anpr-journeys-v1');

/* ----------------------------------------------------------------- walking -- */

/** Cameras that actually record, weighted for use as journey origins. */
const usableCameras = cameraCodes.filter((code) => captureRate(code) > 0);

const ORIGIN_WEIGHTS = usableCameras.map(
  (code) => 0.4 + hashUnit('origin', code) * 1.6,
);

/**
 * Walk the link graph from `startCode`. Avoids immediate backtracking and
 * revisits, and occasionally teleports to a non-adjacent camera to represent a
 * stretch of unmonitored road.
 */
function walk(startCode: string, hops: number, seedKey: string): string[] {
  const path = [startCode];

  for (let i = 0; i < hops; i += 1) {
    const current = path[path.length - 1]!;
    const options = (outgoingLinks.get(current) ?? [])
      .map((link) => link.properties.to_camera_code)
      .filter((code) => captureRate(code) > 0 && !path.includes(code));

    const teleport = hashUnit(seedKey, 'tp', i) < 0.08;
    if (teleport) {
      const far = usableCameras.filter(
        (code) => !path.includes(code) && !options.includes(code),
      );
      const pick = far[Math.floor(hashUnit(seedKey, 'far', i) * far.length)];
      if (pick) {
        path.push(pick);
        continue;
      }
    }

    if (options.length === 0) break;
    const pick = options[Math.floor(hashUnit(seedKey, 'step', i) * options.length)];
    if (!pick) break;
    path.push(pick);
  }

  return path;
}

/** Heading a vehicle would show leaving `fromCode` towards `toCode`. */
function headingBetween(fromCode: string, toCode: string): number | null {
  const from = cameraByCode.get(fromCode);
  const to = cameraByCode.get(toCode);
  if (!from || !to) return null;
  return bearingDegrees(from.geometry.coordinates, to.geometry.coordinates);
}

/* ---------------------------------------------------------------- journeys -- */

export interface Journey {
  journey_id: string;
  normalized_plate: string;
  camera_codes: string[];
  sighting_ids: string[];
  started_at: string;
  ended_at: string;
}

export interface ScenarioMarker {
  anomaly_reason: AnomalyReason;
  label: string;
  sighting_id: string;
  previous_sighting_id: string | null;
  camera_link_id: string | null;
  match_confidence: number;
  details: AlertDetails;
}

const sightings: Sighting[] = [];
const journeys: Journey[] = [];
const scenarios: ScenarioMarker[] = [];

let trackCounter = 1000;

function nextTrack(): number {
  trackCounter += 1;
  return trackCounter;
}

/** Draw a start time in the sighting window, biased towards busy periods. */
function sampleStartMs(seedKey: string): number {
  let best = SIGHTINGS_START;
  let bestWeight = -1;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate =
      SIGHTINGS_START +
      hashUnit(seedKey, 'when', attempt) * (DATASET_NOW - SIGHTINGS_START);
    const weight = demandWeight(candidate) * (0.55 + hashUnit(seedKey, 'w', attempt) * 0.45);
    if (weight > bestWeight) {
      bestWeight = weight;
      best = candidate;
    }
  }
  return Math.round(best);
}

function emitJourney(plate: string, path: string[], startMs: number, seedKey: string): Journey {
  const ids: string[] = [];
  let cursor = startMs;

  path.forEach((cameraCode, index) => {
    const nextCode = path[index + 1];
    const heading =
      nextCode !== undefined
        ? headingBetween(cameraCode, nextCode)
        : headingBetween(path[index - 1] ?? cameraCode, cameraCode);

    const sighting = buildSighting({
      plate,
      cameraCode,
      atMs: cursor,
      trackIndex: nextTrack(),
      directionDegrees: heading,
    });
    sightings.push(sighting);
    ids.push(sighting.sighting_id);

    if (nextCode !== undefined) {
      const link = findLink(cameraCode, nextCode);
      if (link) {
        cursor += sampleTravelTimeSeconds(cameraCode, nextCode, cursor, `${seedKey}:${index}`) * 1000;
      } else {
        // Unmonitored detour: plausible but unverifiable time on the road.
        cursor += Math.round(120 + hashUnit(seedKey, 'gap', index) * 420) * 1000;
      }
    }
  });

  const journey: Journey = {
    journey_id: stableUuid(`journey:${seedKey}`),
    normalized_plate: plate,
    camera_codes: path,
    sighting_ids: ids,
    started_at: new Date(startMs).toISOString(),
    ended_at: new Date(cursor).toISOString(),
  };
  journeys.push(journey);
  return journey;
}

/* --- background traffic ---------------------------------------------------- */

const BACKGROUND_JOURNEY_COUNT = 640;

for (let i = 0; i < BACKGROUND_JOURNEY_COUNT; i += 1) {
  const seedKey = `bg-${i}`;
  // Weight towards the frequent-plate list so searches usually find history.
  const plate =
    hashUnit(seedKey, 'freq') < 0.45
      ? frequentPlates[Math.floor(hashUnit(seedKey, 'fp') * frequentPlates.length)]!
      : plates[Math.floor(hashUnit(seedKey, 'ap') * plates.length)]!.normalized_plate;

  const origin = rng.weighted(usableCameras, ORIGIN_WEIGHTS);
  const hops = 2 + Math.floor(hashUnit(seedKey, 'hops') * 4);
  const path = walk(origin, hops, seedKey);
  if (path.length < 2) continue;

  emitJourney(plate, path, sampleStartMs(seedKey), seedKey);
}

/* --- story journeys ------------------------------------------------------- */

/** The clean multi-hop trajectory used to demo playback. */
emitJourney(
  STORY_PLATES.commuter,
  ['CAM-12', 'CAM-11', 'CAM-01', 'CAM-02', 'CAM-03', 'CAM-04'],
  DATASET_NOW - 96 * 60_000,
  'story-commuter-recent',
);
emitJourney(
  STORY_PLATES.commuter,
  ['CAM-04', 'CAM-10'],
  DATASET_NOW - 27 * 60 * 60_000,
  'story-commuter-yesterday',
);
emitJourney(
  STORY_PLATES.commuter,
  ['CAM-01', 'CAM-05', 'CAM-06'],
  DATASET_NOW - 51 * 60 * 60_000,
  'story-commuter-earlier',
);

/** Stolen vehicle: a recent run so the blacklist alert is fresh on screen. */
emitJourney(
  STORY_PLATES.stolen,
  ['CAM-11', 'CAM-01', 'CAM-02', 'CAM-08'],
  DATASET_NOW - 13 * 60_000,
  'story-stolen-live',
);
emitJourney(
  STORY_PLATES.stolen,
  ['CAM-07', 'CAM-09', 'CAM-04'],
  DATASET_NOW - 20 * 60 * 60_000,
  'story-stolen-prior',
);

emitJourney(
  STORY_PLATES.wanted,
  ['CAM-04', 'CAM-03', 'CAM-02', 'CAM-01', 'CAM-12'],
  DATASET_NOW - 74 * 60_000,
  'story-wanted-live',
);

emitJourney(
  STORY_PLATES.violations,
  ['CAM-08', 'CAM-07', 'CAM-09'],
  DATASET_NOW - 38 * 60_000,
  'story-violations',
);

/* --- scenario: contested OCR ---------------------------------------------- */

{
  const plate = STORY_PLATES.contested;
  const startMs = DATASET_NOW - 62 * 60_000;

  const first = buildSighting({
    plate,
    cameraCode: 'CAM-03',
    atMs: startMs,
    trackIndex: nextTrack(),
    directionDegrees: headingBetween('CAM-03', 'CAM-04'),
    forceMisread: true,
    forceValidation: 'uncertain',
    validationReason: 'top two OCR candidates within 0.04 confidence',
  });
  const second = buildSighting({
    plate,
    cameraCode: 'CAM-04',
    atMs: startMs + 210_000,
    trackIndex: nextTrack(),
    directionDegrees: headingBetween('CAM-03', 'CAM-04'),
    forceValidation: 'conflict',
    validationReason: 'resolved plate contradicts the preceding accepted sighting',
  });
  sightings.push(first, second);
  journeys.push({
    journey_id: stableUuid('journey:story-contested'),
    normalized_plate: plate,
    camera_codes: ['CAM-03', 'CAM-04'],
    sighting_ids: [first.sighting_id, second.sighting_id],
    started_at: first.spotted_at,
    ended_at: second.spotted_at,
  });
}

/* --- scenario: impossible travel time ------------------------------------- */

{
  const plate = STORY_PLATES.impossible;
  const link = findLink('CAM-01', 'CAM-02');
  const startMs = DATASET_NOW - 22 * 60_000;
  const observedSeconds = 45;

  const first = buildSighting({
    plate,
    cameraCode: 'CAM-01',
    atMs: startMs,
    trackIndex: nextTrack(),
    directionDegrees: headingBetween('CAM-01', 'CAM-02'),
    forceValidation: 'accepted',
  });
  const second = buildSighting({
    plate,
    cameraCode: 'CAM-02',
    atMs: startMs + observedSeconds * 1000,
    trackIndex: nextTrack(),
    directionDegrees: headingBetween('CAM-01', 'CAM-02'),
    forceValidation: 'accepted',
  });
  sightings.push(first, second);
  journeys.push({
    journey_id: stableUuid('journey:story-impossible'),
    normalized_plate: plate,
    camera_codes: ['CAM-01', 'CAM-02'],
    sighting_ids: [first.sighting_id, second.sighting_id],
    started_at: first.spotted_at,
    ended_at: second.spotted_at,
  });

  if (link) {
    const distance = link.properties.distance_meters;
    const freeFlow = link.properties.free_flow_time_seconds;
    // Physical floor: nobody clears this link faster than 60% of free-flow time.
    const minimum = Math.round(freeFlow * 0.6);
    scenarios.push({
      anomaly_reason: 'impossible_travel_time',
      label: 'Cleared MG Road in 45 s — 113 km/h implied on a 50 km/h corridor',
      sighting_id: second.sighting_id,
      previous_sighting_id: first.sighting_id,
      camera_link_id: link.properties.camera_link_id,
      match_confidence: 0.94,
      details: {
        observed_travel_time_seconds: observedSeconds,
        minimum_travel_time_seconds: minimum,
        free_flow_time_seconds: freeFlow,
        distance_meters: distance,
        implied_speed_kph: Number(((distance / observedSeconds) * 3.6).toFixed(1)),
        camera_link_id: link.properties.camera_link_id,
        note: 'Observed transit is below the physical minimum for this link.',
      },
    });
  }
}

/* --- scenario: wrong direction -------------------------------------------- */

{
  const plate = STORY_PLATES.wrongWay;
  const link = findLink('CAM-02', 'CAM-08');
  const startMs = DATASET_NOW - 47 * 60_000;
  const forward = headingBetween('CAM-02', 'CAM-08') ?? 180;
  const against = (forward + 180) % 360;

  const first = buildSighting({
    plate,
    cameraCode: 'CAM-02',
    atMs: startMs,
    trackIndex: nextTrack(),
    directionDegrees: forward,
    forceValidation: 'accepted',
  });
  const second = buildSighting({
    plate,
    cameraCode: 'CAM-08',
    atMs: startMs + 260_000,
    trackIndex: nextTrack(),
    // Recorded heading contradicts the link it must have travelled.
    directionDegrees: against,
    forceValidation: 'accepted',
  });
  sightings.push(first, second);
  journeys.push({
    journey_id: stableUuid('journey:story-wrongway'),
    normalized_plate: plate,
    camera_codes: ['CAM-02', 'CAM-08'],
    sighting_ids: [first.sighting_id, second.sighting_id],
    started_at: first.spotted_at,
    ended_at: second.spotted_at,
  });

  if (link) {
    scenarios.push({
      anomaly_reason: 'wrong_direction',
      label: `Recorded heading opposes the ${link.properties.direction_label} carriageway on Brigade Road`,
      sighting_id: second.sighting_id,
      previous_sighting_id: first.sighting_id,
      camera_link_id: link.properties.camera_link_id,
      match_confidence: 0.86,
      details: {
        expected_direction_label: link.properties.direction_label ?? undefined,
        observed_direction_degrees: Number(against.toFixed(1)),
        camera_link_id: link.properties.camera_link_id,
        note: 'Heading is within 15° of the opposing carriageway.',
      },
    });
  }
}

/* --- scenario: suspected clone -------------------------------------------- */

{
  const plate = STORY_PLATES.clone;
  const startMs = DATASET_NOW - 9 * 60_000;
  const separationSeconds = 70;

  const west = buildSighting({
    plate,
    cameraCode: 'CAM-04',
    atMs: startMs,
    trackIndex: nextTrack(),
    directionDegrees: headingBetween('CAM-04', 'CAM-03'),
    forceValidation: 'accepted',
  });
  const east = buildSighting({
    plate,
    cameraCode: 'CAM-11',
    atMs: startMs + separationSeconds * 1000,
    trackIndex: nextTrack(),
    directionDegrees: headingBetween('CAM-11', 'CAM-01'),
    forceValidation: 'accepted',
  });
  sightings.push(west, east);
  journeys.push({
    journey_id: stableUuid('journey:story-clone'),
    normalized_plate: plate,
    camera_codes: ['CAM-04', 'CAM-11'],
    sighting_ids: [west.sighting_id, east.sighting_id],
    started_at: west.spotted_at,
    ended_at: east.spotted_at,
  });

  scenarios.push({
    anomaly_reason: 'suspected_clone',
    label: 'Same plate at opposite ends of the corridor 70 s apart',
    sighting_id: east.sighting_id,
    previous_sighting_id: west.sighting_id,
    camera_link_id: null,
    match_confidence: 0.91,
    details: {
      concurrent_camera_codes: ['CAM-04', 'CAM-11'],
      separation_seconds: separationSeconds,
      note: 'No route between these cameras is traversable in the observed gap; two vehicles are likely carrying the same plate.',
    },
  });
}

/* ------------------------------------------------------------------ output -- */

sightings.sort((a, b) => Date.parse(a.spotted_at) - Date.parse(b.spotted_at));

export const generatedSightings: readonly Sighting[] = sightings;
export const generatedJourneys: readonly Journey[] = journeys;
export const scenarioMarkers: readonly ScenarioMarker[] = scenarios;
