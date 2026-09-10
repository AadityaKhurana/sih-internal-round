/**
 * Geospatial helpers.
 *
 * The API speaks GeoJSON (`[lng, lat]`); Leaflet speaks `[lat, lng]`. Every
 * crossing between the two goes through `toLatLng` / `toLatLngs` so the axis
 * order is swapped in exactly one place.
 */

import type {
  LatLngBoundsTuple,
  LatLngTuple,
  LineStringGeometry,
  Position,
} from '@/types/geo';

const EARTH_RADIUS_M = 6_371_008.8;
const DEG_TO_RAD = Math.PI / 180;

/* --------------------------------------------------------- axis conversion -- */

export function toLatLng(position: Position): LatLngTuple {
  return [position[1], position[0]];
}

export function toLatLngs(coordinates: readonly Position[]): LatLngTuple[] {
  return coordinates.map(toLatLng);
}

export function lineToLatLngs(line: LineStringGeometry | null): LatLngTuple[] {
  return line ? toLatLngs(line.coordinates) : [];
}

/* ------------------------------------------------------------- measurement -- */

/** Great-circle distance in metres between two `[lng, lat]` points. */
export function haversineMeters(a: Position, b: Position): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLng = (lng2 - lng1) * DEG_TO_RAD;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total length of a polyline in metres. */
export function lineLengthMeters(coordinates: readonly Position[]): number {
  let total = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    total += haversineMeters(coordinates[i - 1]!, coordinates[i]!);
  }
  return total;
}

/** Initial bearing a→b, degrees clockwise from north (0–360). */
export function bearingDegrees(a: Position, b: Position): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const φ1 = lat1 * DEG_TO_RAD;
  const φ2 = lat2 * DEG_TO_RAD;
  const Δλ = (lng2 - lng1) * DEG_TO_RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / DEG_TO_RAD + 360) % 360;
}

const COMPASS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** Nearest 8-point compass abbreviation for a bearing. */
export function compassPoint(bearing: number): string {
  const index = Math.round((((bearing % 360) + 360) % 360) / 45) % 8;
  return COMPASS_8[index] ?? 'N';
}

/**
 * Direction label in the style used by `camera_links.direction_label`
 * ('NB', 'SB', 'EB', 'WB', 'NE-B' …). Bound traffic reads better than a raw
 * bearing on a map label.
 */
export function directionLabel(bearing: number): string {
  return `${compassPoint(bearing)}B`;
}

/** Human heading, e.g. `168° SE`. */
export function formatHeading(degrees: number | null): string {
  if (degrees === null || !Number.isFinite(degrees)) return '—';
  return `${Math.round(degrees)}° ${compassPoint(degrees)}`;
}

/* -------------------------------------------------------------- traversal --- */

export interface LinePoint {
  position: Position;
  /** Bearing of the segment the point sits on. */
  bearing: number;
}

/**
 * Point at `fraction` (0–1) of the way along a polyline, measured by distance
 * rather than vertex count, plus the local bearing. Drives the trajectory
 * playback marker.
 */
export function pointAlongLine(
  coordinates: readonly Position[],
  fraction: number,
): LinePoint | null {
  if (coordinates.length === 0) return null;
  const first = coordinates[0]!;
  if (coordinates.length === 1) return { position: first, bearing: 0 };

  const clamped = Math.max(0, Math.min(1, fraction));
  const total = lineLengthMeters(coordinates);
  if (total === 0) return { position: first, bearing: 0 };

  let travelled = 0;
  const target = total * clamped;

  for (let i = 1; i < coordinates.length; i += 1) {
    const a = coordinates[i - 1]!;
    const b = coordinates[i]!;
    const segment = haversineMeters(a, b);
    if (travelled + segment >= target || i === coordinates.length - 1) {
      const t = segment === 0 ? 0 : (target - travelled) / segment;
      return {
        position: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
        bearing: bearingDegrees(a, b),
      };
    }
    travelled += segment;
  }

  return { position: coordinates[coordinates.length - 1]!, bearing: 0 };
}

/**
 * The leading portion of a polyline, from the start up to `fraction` of its
 * length. Used to draw how far along a route the playback cursor has reached, so
 * travelled and untravelled road are visually distinct.
 */
export function sliceLine(
  coordinates: readonly Position[],
  fraction: number,
): Position[] {
  if (coordinates.length < 2) return [...coordinates];

  const clamped = Math.max(0, Math.min(1, fraction));
  if (clamped <= 0) return [];
  if (clamped >= 1) return [...coordinates];

  const total = lineLengthMeters(coordinates);
  if (total === 0) return [...coordinates];

  const target = total * clamped;
  const out: Position[] = [coordinates[0]!];
  let travelled = 0;

  for (let i = 1; i < coordinates.length; i += 1) {
    const a = coordinates[i - 1]!;
    const b = coordinates[i]!;
    const segment = haversineMeters(a, b);

    if (travelled + segment >= target) {
      const t = segment === 0 ? 0 : (target - travelled) / segment;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      return out;
    }

    out.push(b);
    travelled += segment;
  }

  return out;
}

/** Midpoint by distance — used to anchor link labels. */
export function lineMidpoint(coordinates: readonly Position[]): Position | null {
  return pointAlongLine(coordinates, 0.5)?.position ?? null;
}

/**
 * Shift a polyline sideways by `meters` (positive = to the right of travel).
 *
 * The camera network stores A→B and B→A as two separate rows with mirrored
 * geometry. Drawn raw they sit exactly on top of each other and one direction
 * becomes invisible, so each direction is nudged onto its own side of the road.
 */
export function offsetLine(
  coordinates: readonly Position[],
  meters: number,
): Position[] {
  if (coordinates.length < 2) return [...coordinates];

  return coordinates.map((point, index) => {
    const prev = coordinates[Math.max(0, index - 1)]!;
    const next = coordinates[Math.min(coordinates.length - 1, index + 1)]!;
    const bearing = bearingDegrees(prev, next);
    // Perpendicular, to the right of the direction of travel.
    const perpendicular = (bearing + 90) * DEG_TO_RAD;
    const latRad = point[1] * DEG_TO_RAD;
    const dLat = (meters * Math.cos(perpendicular)) / 111_320;
    const dLng =
      (meters * Math.sin(perpendicular)) / (111_320 * Math.max(0.1, Math.cos(latRad)));
    return [point[0] + dLng, point[1] + dLat] as Position;
  });
}

/**
 * Point `meters` away from `origin` along `bearing`. Flat-earth approximation,
 * which is exact enough at the scale of a few hundred metres and avoids the
 * spherical maths for what is only ever used to draw map decoration.
 */
export function destinationPoint(
  origin: Position,
  bearing: number,
  meters: number,
): Position {
  const rad = bearing * DEG_TO_RAD;
  const latRad = origin[1] * DEG_TO_RAD;
  const dLat = (meters * Math.cos(rad)) / 111_320;
  const dLng = (meters * Math.sin(rad)) / (111_320 * Math.max(0.1, Math.cos(latRad)));
  return [origin[0] + dLng, origin[1] + dLat];
}

/**
 * A chevron pointing along the direction of travel at `fraction` of the way
 * along a polyline. Drawn as an open 3-point polyline, so it needs no marker
 * icons or extra DOM — it is just another path in the same pane.
 */
export function chevronAlongLine(
  coordinates: readonly Position[],
  fraction: number,
  sizeMeters: number,
): Position[] | null {
  const at = pointAlongLine(coordinates, fraction);
  if (!at) return null;
  const back = at.bearing + 180;
  return [
    destinationPoint(at.position, back - 32, sizeMeters),
    at.position,
    destinationPoint(at.position, back + 32, sizeMeters),
  ];
}

/**
 * Insert gently curved intermediate vertices between two points. Straight
 * hop lines read as "we guessed"; a slight bow reads as a road.
 */
export function curveBetween(a: Position, b: Position, bow = 0.14): Position[] {
  const mid: Position = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const control: Position = [mid[0] - dy * bow, mid[1] + dx * bow];

  const points: Position[] = [];
  const steps = 12;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const inv = 1 - t;
    points.push([
      inv * inv * a[0] + 2 * inv * t * control[0] + t * t * b[0],
      inv * inv * a[1] + 2 * inv * t * control[1] + t * t * b[1],
    ]);
  }
  return points;
}

/* ----------------------------------------------------------------- bounds --- */

export function boundsOf(
  positions: readonly Position[],
  padDegrees = 0.004,
): LatLngBoundsTuple | null {
  if (positions.length === 0) return null;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  for (const [lng, lat] of positions) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  }

  return [
    [minLat - padDegrees, minLng - padDegrees],
    [maxLat + padDegrees, maxLng + padDegrees],
  ];
}

/* ------------------------------------------------------------ formatting --- */

export function formatDistance(meters: number | null): string {
  if (meters === null || !Number.isFinite(meters)) return '—';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

export function formatCoords(position: Position): string {
  return `${position[1].toFixed(5)}, ${position[0].toFixed(5)}`;
}

/** metres + seconds → km/h. Returns null when the inputs can't give a speed. */
export function speedKph(meters: number | null, seconds: number | null): number | null {
  if (
    meters === null ||
    seconds === null ||
    !Number.isFinite(meters) ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    return null;
  }
  return (meters / seconds) * 3.6;
}

export function formatSpeed(kph: number | null): string {
  if (kph === null || !Number.isFinite(kph)) return '—';
  return `${kph.toFixed(1)} km/h`;
}
