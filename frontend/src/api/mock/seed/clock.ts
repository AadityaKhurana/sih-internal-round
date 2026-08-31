/**
 * The demo dataset's frame of reference.
 *
 * Everything is anchored to a single instant captured when the module loads, so
 * one page session sees a stable dataset (a plate's trajectory does not shift
 * under you between two requests) while a fresh reload always produces data that
 * ends "now" — no stale fixture timestamps in a demo.
 */

import { DAY_MS, FIVE_MIN_MS, startOfDay } from '@/lib/time';

/** "Now" for the whole fixture layer, floored to a 5-minute metric boundary. */
export const DATASET_NOW = Math.floor(Date.now() / FIVE_MIN_MS) * FIVE_MIN_MS;

/** Days of synthetic history. Enough for a monthly report plus its comparison. */
export const HISTORY_DAYS = 70;

/** Local midnight, `HISTORY_DAYS` back — the earliest window with data. */
export const DATASET_START = startOfDay(DATASET_NOW - HISTORY_DAYS * DAY_MS).getTime();

/**
 * Individual sightings are only materialised for the recent past; analytics
 * further back come from the analytic demand model. Keeps the in-memory dataset
 * small while still supporting monthly reports.
 */
export const SIGHTING_HISTORY_DAYS = 4;

export const SIGHTINGS_START = DATASET_NOW - SIGHTING_HISTORY_DAYS * DAY_MS;

export function clampToDataset(ms: number): number {
  return Math.min(Math.max(ms, DATASET_START), DATASET_NOW);
}
