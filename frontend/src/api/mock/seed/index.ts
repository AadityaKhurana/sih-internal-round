/**
 * Assembled demo dataset — the single object the mock API queries against.
 *
 * Built once per page load. Mutations from the UI (acknowledging an alert, adding
 * a blacklist entry) mutate this in place, so the app behaves like it is talking
 * to a real backend within a session; a reload resets to the seed.
 */

import type { Alert, BlacklistEntry, Sighting } from '@/types/domain';
import { DATASET_NOW, DATASET_START, SIGHTINGS_START } from './clock';
import { generatedAlerts } from './alerts';
import { generatedJourneys, generatedSightings, type Journey } from './journeys';
import {
  cameraByCode,
  cameraCodes,
  cameraFeatures,
  cameraLinkFeatures,
  camerasCollection,
  cameraLinksCollection,
  findLink,
  linkById,
  outgoingLinks,
  roads,
} from './network';
import { blacklistSeedEntries, plates } from './plates';

/* ------------------------------------------------- derived camera liveness -- */

/** Most recent sighting per camera → `cameras.last_seen_at`. */
const lastSeenByCamera = new Map<string, string>();
for (const sighting of generatedSightings) {
  const current = lastSeenByCamera.get(sighting.camera_code);
  if (!current || sighting.spotted_at > current) {
    lastSeenByCamera.set(sighting.camera_code, sighting.spotted_at);
  }
}

for (const feature of cameraFeatures) {
  const status = feature.properties.status;
  if (status === 'fault' || status === 'inactive') {
    // A camera that is down has a stale heartbeat — that is the point of the flag.
    feature.properties.last_seen_at = new Date(
      DATASET_NOW - (status === 'fault' ? 3.5 : 46) * 60 * 60_000,
    ).toISOString();
    continue;
  }
  feature.properties.last_seen_at =
    lastSeenByCamera.get(feature.properties.camera_code) ??
    new Date(DATASET_NOW - 4 * 60_000).toISOString();
}

/* ----------------------------------------------- blacklist activity rollup -- */

const blacklistEntries: BlacklistEntry[] = blacklistSeedEntries.map((entry) => {
  const matches = generatedSightings.filter(
    (s) => s.normalized_plate === entry.normalized_plate,
  );
  const last = matches[matches.length - 1];
  return {
    ...entry,
    sighting_count: matches.length,
    last_seen_at: last?.spotted_at ?? null,
  };
});

/* ---------------------------------------------------------------- indexes --- */

const sightingsByPlate = new Map<string, Sighting[]>();
for (const sighting of generatedSightings) {
  const key = sighting.normalized_plate ?? sighting.normalized_plate_candidate;
  if (!key) continue;
  const list = sightingsByPlate.get(key) ?? [];
  list.push(sighting);
  sightingsByPlate.set(key, list);
}
for (const list of sightingsByPlate.values()) {
  list.sort((a, b) => Date.parse(a.spotted_at) - Date.parse(b.spotted_at));
}

/* ----------------------------------------------------------------- dataset -- */

export interface MockDataset {
  now: number;
  historyStart: number;
  sightingsStart: number;
  roads: typeof roads;
  cameras: typeof camerasCollection;
  cameraLinks: typeof cameraLinksCollection;
  cameraCodes: readonly string[];
  plates: typeof plates;
  /** Mutable: the UI can add and update entries. */
  blacklist: BlacklistEntry[];
  sightings: readonly Sighting[];
  sightingsByPlate: Map<string, Sighting[]>;
  journeys: readonly Journey[];
  /** Mutable: acknowledgement writes here. */
  alerts: Alert[];
}

export const dataset: MockDataset = {
  now: DATASET_NOW,
  historyStart: DATASET_START,
  sightingsStart: SIGHTINGS_START,
  roads,
  cameras: camerasCollection,
  cameraLinks: cameraLinksCollection,
  cameraCodes,
  plates,
  blacklist: blacklistEntries,
  sightings: generatedSightings,
  sightingsByPlate,
  journeys: generatedJourneys,
  alerts: [...generatedAlerts],
};

export {
  cameraByCode,
  cameraFeatures,
  cameraLinkFeatures,
  findLink,
  linkById,
  outgoingLinks,
};
export { DATASET_NOW, DATASET_START, SIGHTINGS_START };
export type { Journey };
