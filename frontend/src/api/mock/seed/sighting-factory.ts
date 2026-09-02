/**
 * Builds a single `sightings` row.
 *
 * Pure: every field derives from the sighting's own identity via `hashUnit`, so
 * the same arguments always produce the same row. That keeps the seed
 * reproducible and lets the live mock stream mint new sightings after seeding
 * without disturbing anything already generated.
 *
 * The OCR fields are internally consistent on purpose: poor conditions lower
 * `ocr_confidence`, a low confidence is what produces a misread
 * `raw_plate_text`, and the resulting confidence is what decides
 * `validation_status`. A UI that shows a 0.61-confidence "accepted" plate teaches
 * an operator to distrust the whole screen.
 */

import { OCR_CONFUSIONS } from '@/lib/plate';
import { hashUnit, stableUuid } from '@/lib/rng';
import type { OcrCandidate, Sighting, ValidationStatus } from '@/types/domain';
import { DATASET_NOW } from './clock';
import { cameraByCode } from './network';
import { plateId } from './plates';

const VEHICLE_TYPES = ['car', 'two_wheeler', 'auto_rickshaw', 'bus', 'truck'] as const;
const VEHICLE_TYPE_WEIGHTS = [0.54, 0.27, 0.08, 0.05, 0.06] as const;

const VEHICLE_COLORS = [
  'white',
  'silver',
  'grey',
  'black',
  'red',
  'blue',
  'brown',
  'yellow',
] as const;
const VEHICLE_COLOR_WEIGHTS = [0.3, 0.18, 0.14, 0.13, 0.08, 0.09, 0.04, 0.04] as const;

export const MODEL_VERSION = 'anpr-v1.3.0';

/** Deterministic weighted pick driven by a unit hash rather than a PRNG. */
function pickWeighted<T>(items: readonly T[], weights: readonly number[], unit: number): T {
  const total = weights.reduce((sum, w) => sum + w, 0);
  let roll = unit * total;
  for (let i = 0; i < items.length; i += 1) {
    roll -= weights[i] ?? 0;
    if (roll <= 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

/** `20260828T103142` — the compact UTC stamp used by the event-id convention. */
export function compactTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
}

function objectKeyDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

/** Swap one character for an OCR look-alike, mimicking a misread. */
function corruptPlate(plate: string, seedKey: string): string {
  const index = Math.floor(hashUnit(seedKey, 'pos') * plate.length);
  const char = plate[index];
  if (char === undefined) return plate;
  const options = OCR_CONFUSIONS.filter((pair) => pair[0] === char);
  if (options.length === 0) return plate;
  const swap = options[Math.floor(hashUnit(seedKey, 'swap') * options.length)];
  if (!swap) return plate;
  return `${plate.slice(0, index)}${swap[1]}${plate.slice(index + 1)}`;
}

function isNightHour(ms: number): boolean {
  const hour = new Date(ms).getHours();
  return hour >= 19 || hour < 6;
}

export interface BuildSightingArgs {
  /** The vehicle's true plate. OCR may or may not read it correctly. */
  plate: string;
  cameraCode: string;
  atMs: number;
  trackIndex: number;
  directionDegrees: number | null;
  /** Force a validation status instead of deriving it from confidence. */
  forceValidation?: ValidationStatus;
  validationReason?: string | null;
  /** Force the OCR to disagree with the true plate. */
  forceMisread?: boolean;
  /**
   * Instant the row is considered "current" relative to. Freshly ingested rows
   * are `pending` because the validation sweep has not reached them yet.
   */
  nowMs?: number;
}

export function buildSighting(args: BuildSightingArgs): Sighting {
  const camera = cameraByCode.get(args.cameraCode);
  if (!camera) throw new Error(`Unknown camera code: ${args.cameraCode}`);

  const nowMs = args.nowMs ?? DATASET_NOW;
  const truePlate = args.plate;
  const trackId = `track-${args.trackIndex}`;
  const sourceEventId = `${args.cameraCode.toLowerCase().replace('-', '')}-${trackId}-${compactTimestamp(args.atMs)}`;
  const seedKey = `${sourceEventId}:${truePlate}`;

  const night = isNightHour(args.atMs);
  const motionBlur = hashUnit(seedKey, 'blur') < (night ? 0.3 : 0.14);
  const angled = hashUnit(seedKey, 'angle') < 0.12;
  const occluded = hashUnit(seedKey, 'occl') < 0.06;

  let ocrConfidence =
    0.965 -
    (night ? 0.075 : 0) -
    (motionBlur ? 0.085 : 0) -
    (angled ? 0.055 : 0) -
    (occluded ? 0.13 : 0) -
    hashUnit(seedKey, 'conf') * 0.06;
  ocrConfidence = Math.max(0.42, Math.min(0.995, ocrConfidence));

  const misread = args.forceMisread ?? ocrConfidence < 0.78;
  const misreadPlate = corruptPlate(truePlate, seedKey);
  const rawPlateText = misread ? misreadPlate : truePlate;

  // Below the floor the worker cannot commit to any candidate.
  const normalizedCandidate =
    ocrConfidence < 0.6 ? null : misread ? misreadPlate : truePlate;

  const candidates: OcrCandidate[] = [];
  if (normalizedCandidate) {
    candidates.push({
      plate: normalizedCandidate,
      confidence: Number(ocrConfidence.toFixed(4)),
    });
    const runnerUp = normalizedCandidate === truePlate ? misreadPlate : truePlate;
    if (runnerUp !== normalizedCandidate) {
      candidates.push({
        plate: runnerUp,
        confidence: Number(
          Math.max(0.2, ocrConfidence - 0.09 - hashUnit(seedKey, 'alt') * 0.12).toFixed(4),
        ),
      });
    }
  }

  let validationStatus: ValidationStatus;
  let validationReason: string | null = null;

  if (args.forceValidation) {
    validationStatus = args.forceValidation;
    validationReason = args.validationReason ?? null;
  } else if (args.atMs > nowMs - 120_000) {
    validationStatus = 'pending';
    validationReason = 'awaiting validation sweep';
  } else if (normalizedCandidate === null) {
    validationStatus = 'uncertain';
    validationReason = 'no candidate above the confidence floor';
  } else if (ocrConfidence < 0.72) {
    validationStatus = 'uncertain';
    validationReason = `ocr_confidence ${ocrConfidence.toFixed(2)} below accept threshold 0.72`;
  } else if (hashUnit(seedKey, 'conflict') < 0.006) {
    validationStatus = 'conflict';
    validationReason = 'resolved plate contradicts an adjacent accepted sighting';
  } else {
    validationStatus = 'accepted';
  }

  const resolvedPlate = validationStatus === 'accepted' ? normalizedCandidate : null;
  const dateKey = objectKeyDate(args.atMs);

  return {
    sighting_id: stableUuid(`sighting:${sourceEventId}`),
    source_event_id: sourceEventId,
    camera_id: camera.properties.camera_id,
    camera_code: args.cameraCode,
    camera_display_name: camera.properties.display_name,
    camera_location: camera.geometry.coordinates,
    plate_id: resolvedPlate ? plateId(resolvedPlate) : null,
    normalized_plate: resolvedPlate,
    raw_plate_text: rawPlateText,
    normalized_plate_candidate: normalizedCandidate,
    camera_track_id: trackId,
    detection_confidence: Number((0.9 + hashUnit(seedKey, 'det') * 0.098).toFixed(4)),
    ocr_confidence: Number(ocrConfidence.toFixed(4)),
    ocr_candidates: candidates,
    validation_status: validationStatus,
    validation_reason: validationReason,
    spotted_at: new Date(args.atMs).toISOString(),
    processed_at: new Date(
      args.atMs + 900 + Math.floor(hashUnit(seedKey, 'proc') * 2600),
    ).toISOString(),
    direction_degrees:
      args.directionDegrees === null ? null : Number(args.directionDegrees.toFixed(2)),
    vehicle_type: pickWeighted(VEHICLE_TYPES, VEHICLE_TYPE_WEIGHTS, hashUnit(seedKey, 'vt')),
    vehicle_color: pickWeighted(
      VEHICLE_COLORS,
      VEHICLE_COLOR_WEIGHTS,
      hashUnit(seedKey, 'vc'),
    ),
    lane_number: 1 + Math.floor(hashUnit(seedKey, 'lane') * 3),
    quality_flags: {
      night,
      motion_blur: motionBlur,
      angled,
      occluded,
    },
    model_version: MODEL_VERSION,
    plate_crop_object_key: `crops/${args.cameraCode}/${dateKey}/${trackId}.jpg`,
    vehicle_image_object_key: `vehicles/${args.cameraCode}/${dateKey}/${trackId}.jpg`,
    context_clip_object_key:
      hashUnit(seedKey, 'clip') < 0.55
        ? `clips/${args.cameraCode}/${dateKey}/${trackId}.mp4`
        : null,
  };
}
