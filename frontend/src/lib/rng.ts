/**
 * Deterministic randomness for the fixture layer.
 *
 * Every number in the demo dataset derives from a seed, so a demo run is
 * reproducible: the same plate takes the same route, the scripted anomaly fires
 * at the same moment, and screenshots match. Nothing here is cryptographic.
 */

/** xmur3 string hash → 32-bit seed. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32 PRNG — small, fast, good enough for fixtures. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Uniform float in [min, max). */
  float(min: number, max: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** Uniform pick. Throws on an empty array so callers can't get undefined. */
  pick<T>(items: readonly T[]): T;
  /** Weighted pick; `weights` must align with `items` and sum > 0. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** Fisher–Yates copy. */
  shuffle<T>(items: readonly T[]): T[];
  /** Approximately normal via the sum of 3 uniforms (Bates distribution). */
  normal(mean: number, stdDev: number): number;
}

export function createRng(seedText: string): Rng {
  const next = mulberry32(xmur3(seedText)());

  const rng: Rng = {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    float: (min, max) => next() * (max - min) + min,
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new Error('Rng.pick: empty array');
      return items[Math.floor(next() * items.length)] ?? items[0]!;
    },
    weighted: (items, weights) => {
      if (items.length === 0) throw new Error('Rng.weighted: empty array');
      const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
      if (total <= 0) return items[0]!;
      let roll = next() * total;
      for (let i = 0; i < items.length; i += 1) {
        roll -= Math.max(0, weights[i] ?? 0);
        if (roll <= 0) return items[i]!;
      }
      return items[items.length - 1]!;
    },
    shuffle: (items) => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        const a = copy[i]!;
        const b = copy[j]!;
        copy[i] = b;
        copy[j] = a;
      }
      return copy;
    },
    normal: (mean, stdDev) => {
      const bates = (next() + next() + next()) / 3;
      // Bates(3) has sd = 1/(2*sqrt(3)*... ) ≈ 0.1667; scale to the target sd.
      return mean + (bates - 0.5) * stdDev * 6;
    },
  };

  return rng;
}

/**
 * Stateless deterministic hash → [0, 1). Used by the analytic demand model so a
 * metric for (camera, window) can be produced on demand without materialising
 * a week of rows.
 */
export function hashUnit(...parts: Array<string | number>): number {
  return xmur3(parts.join('|'))() / 4294967296;
}

/** Stable UUID-shaped id from a seed string, so fixture ids look like real ones. */
export function stableUuid(seedText: string): string {
  const seed = xmur3(seedText);
  const hex: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    hex.push(seed().toString(16).padStart(8, '0'));
  }
  const all = hex.join('');
  // Force version 4 / variant bits so the shape is a valid v4 UUID.
  const v = `4${all.slice(13, 16)}`;
  const variantNibble = ((parseInt(all[16] ?? '8', 16) & 0x3) | 0x8).toString(16);
  return [
    all.slice(0, 8),
    all.slice(8, 12),
    v,
    `${variantNibble}${all.slice(17, 20)}`,
    all.slice(20, 32),
  ].join('-');
}
