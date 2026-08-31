/**
 * Minimal GeoJSON types (RFC 7946) for the subset the API emits.
 *
 * Coordinates are always `[longitude, latitude]` in EPSG:4326, matching
 * `geometry(Point, 4326)` / `geometry(LineString, 4326)` in db/schema.sql.
 * Leaflet expects `[lat, lng]`, so anything crossing into react-leaflet must go
 * through the converters in `@/lib/geo`.
 */

export type Position = [longitude: number, latitude: number];

export interface PointGeometry {
  type: 'Point';
  coordinates: Position;
}

export interface LineStringGeometry {
  type: 'LineString';
  coordinates: Position[];
}

export type Geometry = PointGeometry | LineStringGeometry;

export interface Feature<G extends Geometry, P> {
  type: 'Feature';
  /** Mirrors the row's primary key so React keys are stable. */
  id: string;
  geometry: G;
  properties: P;
}

export interface FeatureCollection<G extends Geometry, P> {
  type: 'FeatureCollection';
  features: Feature<G, P>[];
}

/** Leaflet-order tuple: `[lat, lng]`. */
export type LatLngTuple = [number, number];

/** `[[southLat, westLng], [northLat, eastLng]]` — Leaflet bounds order. */
export type LatLngBoundsTuple = [LatLngTuple, LatLngTuple];
