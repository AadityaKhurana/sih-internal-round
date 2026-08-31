/**
 * Indian registration-plate helpers, client side.
 *
 * Lane A owns the authoritative normaliser (destined for `common/` so the
 * persistence worker reuses it). This module exists so the search box can
 * normalise what an operator types before it hits the API, and so fixtures can
 * generate realistic plates. Keep the normalisation rule — strip everything that
 * is not A–Z or 0–9, then uppercase — identical to the Python side.
 */

/**
 * Standard series: 2-letter state, 1–2 digit RTO, 1–3 letter series, 4 digits.
 * e.g. `KA01AB1234`, `DL8CAF5031`.
 */
const STANDARD = /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{4}$/;

/** Bharat series: 2-digit year, `BH`, 4 digits, 1–2 letters. e.g. `21BH1234AA`. */
const BHARAT = /^\d{2}BH\d{4}[A-Z]{1,2}$/;

/** Uppercase and strip separators. The canonical form stored in `plates`. */
export function normalizePlate(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidPlate(input: string): boolean {
  const plate = normalizePlate(input);
  return STANDARD.test(plate) || BHARAT.test(plate);
}

/**
 * Group a normalised plate for display: `KA01AB1234` → `KA 01 AB 1234`.
 * Falls back to the raw string when it doesn't match a known series, so an
 * unparseable OCR result is still shown rather than hidden.
 */
export function formatPlate(input: string | null): string {
  if (!input) return '—';
  const plate = normalizePlate(input);

  const standard = /^([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{4})$/.exec(plate);
  if (standard) {
    return `${standard[1]} ${standard[2]} ${standard[3]} ${standard[4]}`;
  }

  const bharat = /^(\d{2})(BH)(\d{4})([A-Z]{1,2})$/.exec(plate);
  if (bharat) {
    return `${bharat[1]} ${bharat[2]} ${bharat[3]} ${bharat[4]}`;
  }

  return plate;
}

/**
 * Character pairs OCR habitually confuses on Indian plates. Used by the fixture
 * generator to derive a plausible `raw_plate_text` from a true plate, and by the
 * UI to explain why two candidates are close.
 */
export const OCR_CONFUSIONS: ReadonlyArray<readonly [string, string]> = [
  ['0', 'O'],
  ['1', 'I'],
  ['2', 'Z'],
  ['5', 'S'],
  ['6', 'G'],
  ['8', 'B'],
  ['B', '8'],
  ['D', '0'],
  ['Q', '0'],
];

/** Positions where `a` and `b` differ. Empty when the strings are equal. */
export function plateDiffPositions(a: string | null, b: string | null): number[] {
  if (!a || !b) return [];
  const left = normalizePlate(a);
  const right = normalizePlate(b);
  if (left.length !== right.length) return [];
  const out: number[] = [];
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) out.push(i);
  }
  return out;
}

/** Two-letter state prefix, for grouping. */
export function plateStateCode(input: string | null): string | null {
  if (!input) return null;
  const plate = normalizePlate(input);
  return /^[A-Z]{2}/.test(plate) ? plate.slice(0, 2) : null;
}
