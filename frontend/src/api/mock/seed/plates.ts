/**
 * Plate pool and blacklist fixtures.
 *
 * A handful of "story" plates carry the scripted demo scenarios (blacklist hit,
 * impossible travel, suspected clone, wrong direction, contested OCR). The rest
 * are background traffic so search, O-D and analytics look plausible instead of
 * showing eight vehicles in a whole city.
 */

import { normalizePlate } from '@/lib/plate';
import { createRng, stableUuid } from '@/lib/rng';
import { DAY_MS } from '@/lib/time';
import type { BlacklistEntry, Plate, Severity } from '@/types/domain';
import { DATASET_NOW } from './clock';

const rng = createRng('anpr-plate-pool-v1');

/** State prefixes weighted towards Karnataka, as a Bengaluru corridor would be. */
const STATE_CODES = ['KA', 'KA', 'KA', 'KA', 'KA', 'TN', 'AP', 'MH', 'DL', 'KL', 'TS'];
const SERIES_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomPlate(): string {
  const state = rng.pick(STATE_CODES);
  const rto = String(rng.int(1, 69)).padStart(2, '0');
  const series =
    SERIES_LETTERS[rng.int(0, SERIES_LETTERS.length - 1)]! +
    SERIES_LETTERS[rng.int(0, SERIES_LETTERS.length - 1)]!;
  const number = String(rng.int(1, 9999)).padStart(4, '0');
  return `${state}${rto}${series}${number}`;
}

export function makePlate(normalized: string): Plate {
  const plate = normalizePlate(normalized);
  return { plate_id: stableUuid(`plate:${plate}`), normalized_plate: plate };
}

/* ------------------------------------------------------------ story plates -- */

/**
 * Plates with a scripted role. `journeys.ts` gives each one a hand-built path so
 * the demo can be driven from a script rather than hoping random data cooperates.
 */
export const STORY_PLATES = {
  /** Stolen vehicle, critical blacklist. Long clean run down the MG Road corridor. */
  stolen: 'KA01AB1234',
  /** Wanted in an active case, high severity. Repeat visitor. */
  wanted: 'KA05MJ7788',
  /** Triggers `impossible_travel_time` on the MG Road link. */
  impossible: 'DL08CAF5031',
  /** Seen at opposite ends of the network seconds apart → `suspected_clone`. */
  clone: 'KA41CX7702',
  /** Heading contradicts the link direction → `wrong_direction`. */
  wrongWay: 'KA51HG2210',
  /** Frequent commuter, the "clean long trajectory" demo. */
  commuter: 'KA03MK9012',
  /** Medium-severity blacklist for repeat violations. */
  violations: 'TN09BZ4455',
  /** OCR disagreement — lands as `uncertain` / `conflict`. */
  contested: 'KA02EE0099',
  /** Blacklist entry that has expired — proves status filtering works. */
  expired: 'MH12QR3344',
  /** Blacklist entry manually deactivated. */
  deactivated: 'KA09PL5521',
} as const;

const storyPlateList = Object.values(STORY_PLATES);

/* -------------------------------------------------------------- plate pool -- */

const BACKGROUND_PLATE_COUNT = 380;

const backgroundPlates: string[] = [];
{
  const seen = new Set<string>(storyPlateList);
  let guard = 0;
  while (backgroundPlates.length < BACKGROUND_PLATE_COUNT && guard < 5000) {
    guard += 1;
    const candidate = randomPlate();
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    backgroundPlates.push(candidate);
  }
}

/** Every plate in the demo dataset: story plates first, then background traffic. */
export const plates: readonly Plate[] = [...storyPlateList, ...backgroundPlates].map(
  makePlate,
);

export const plateByNormalized = new Map(
  plates.map((plate) => [plate.normalized_plate, plate]),
);

export function plateId(normalized: string): string {
  return (
    plateByNormalized.get(normalizePlate(normalized))?.plate_id ??
    stableUuid(`plate:${normalizePlate(normalized)}`)
  );
}

/**
 * Plates that appear often enough to look like commuters. Weighting the journey
 * generator towards these means a plate search usually returns a multi-hop
 * trajectory rather than a single lonely sighting.
 */
export const frequentPlates: readonly string[] = [
  ...storyPlateList,
  ...backgroundPlates.slice(0, 60),
];

/* --------------------------------------------------------------- blacklist -- */

interface BlacklistSeed {
  plate: string;
  reason: string;
  severity: Severity;
  status: BlacklistEntry['status'];
  active_from_days_ago: number;
  active_until_days_ago?: number | null;
  added_by: string;
  case_reference: string | null;
}

const BLACKLIST_SEEDS: readonly BlacklistSeed[] = [
  {
    plate: STORY_PLATES.stolen,
    reason: 'Reported stolen — Whitefield PS, FIR 214/2026',
    severity: 'critical',
    status: 'active',
    active_from_days_ago: 12,
    added_by: 'insp.rao',
    case_reference: 'FIR-214-2026',
  },
  {
    plate: STORY_PLATES.wanted,
    reason: 'Vehicle of interest — ongoing investigation',
    severity: 'high',
    status: 'active',
    active_from_days_ago: 26,
    added_by: 'sub.insp.mehta',
    case_reference: 'CASE-88-2026',
  },
  {
    plate: STORY_PLATES.clone,
    reason: 'Suspected cloned registration — duplicate sightings city-wide',
    severity: 'high',
    status: 'active',
    active_from_days_ago: 5,
    added_by: 'analyst.dcosta',
    case_reference: 'INT-1194',
  },
  {
    plate: STORY_PLATES.violations,
    reason: 'Repeat signal violations — 7 pending challans',
    severity: 'medium',
    status: 'active',
    active_from_days_ago: 40,
    added_by: 'traffic.ops',
    case_reference: null,
  },
  {
    plate: STORY_PLATES.impossible,
    reason: 'Flagged for verification — inconsistent movement pattern',
    severity: 'medium',
    status: 'active',
    active_from_days_ago: 3,
    added_by: 'analyst.dcosta',
    case_reference: 'INT-1207',
  },
  {
    plate: STORY_PLATES.expired,
    reason: 'Temporary watch order for a public event',
    severity: 'low',
    status: 'expired',
    active_from_days_ago: 34,
    active_until_days_ago: 27,
    added_by: 'traffic.ops',
    case_reference: 'ORD-2026-31',
  },
  {
    plate: STORY_PLATES.deactivated,
    reason: 'Mistaken identity — cleared after owner verification',
    severity: 'medium',
    status: 'inactive',
    active_from_days_ago: 20,
    active_until_days_ago: 16,
    added_by: 'insp.rao',
    case_reference: 'CASE-71-2026',
  },
];

/**
 * Blacklist rows. `sighting_count` / `last_seen_at` are filled in by the dataset
 * builder once journeys exist, so the management table can show activity without
 * a second request.
 */
export const blacklistSeedEntries: BlacklistEntry[] = BLACKLIST_SEEDS.map((seed) => ({
  blacklist_entry_id: stableUuid(`blacklist:${seed.plate}:${seed.case_reference ?? seed.reason}`),
  plate_id: plateId(seed.plate),
  normalized_plate: normalizePlate(seed.plate),
  reason: seed.reason,
  severity: seed.severity,
  status: seed.status,
  active_from: new Date(DATASET_NOW - seed.active_from_days_ago * DAY_MS).toISOString(),
  active_until:
    seed.active_until_days_ago === undefined || seed.active_until_days_ago === null
      ? null
      : new Date(DATASET_NOW - seed.active_until_days_ago * DAY_MS).toISOString(),
  added_by: seed.added_by,
  case_reference: seed.case_reference,
  sighting_count: 0,
  last_seen_at: null,
}));

/** Plates with a currently-enforceable blacklist entry, for alert generation. */
export function activeBlacklistByPlate(
  entries: readonly BlacklistEntry[],
  atMs: number = DATASET_NOW,
): Map<string, BlacklistEntry> {
  const map = new Map<string, BlacklistEntry>();
  for (const entry of entries) {
    if (entry.status !== 'active') continue;
    if (Date.parse(entry.active_from) > atMs) continue;
    if (entry.active_until !== null && Date.parse(entry.active_until) < atMs) continue;
    map.set(entry.normalized_plate, entry);
  }
  return map;
}
