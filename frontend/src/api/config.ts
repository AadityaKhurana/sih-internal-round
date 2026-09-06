/**
 * Runtime configuration, read once from Vite's env.
 *
 * The mock/real switch lives here and nowhere else. Components and hooks call the
 * `apiClient` and never learn which transport answered, so pointing the dashboard
 * at Lane B's real service is a `.env.local` edit and a reload.
 */

/**
 * Vite replaces `import.meta.env` at build time. Outside Vite — the render smoke
 * test, or any plain Node import of this module — it does not exist, so it is read
 * defensively and every value falls back to its default.
 */
const env: Record<string, string | undefined> =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * `true` → in-browser fixtures + simulated WebSocket, no backend required.
 * `false` → real REST + WebSocket.
 *
 * Defaults to mock so a fresh clone runs with `npm install && npm run dev`.
 */
export const USE_MOCK = flag(env.VITE_USE_MOCK, true);

export const API_BASE_URL = env.VITE_API_BASE_URL ?? '/api';

export const WS_URL = env.VITE_WS_URL ?? '/ws/live';

export const MAP_DEFAULTS = {
  center: [
    num(env.VITE_MAP_CENTER_LAT, 12.9752),
    num(env.VITE_MAP_CENTER_LNG, 77.61),
  ] as [number, number],
  zoom: num(env.VITE_MAP_ZOOM, 14),
  minZoom: 11,
  maxZoom: 18,
};

/**
 * OpenStreetMap raster tiles. Attribution is required by the ODbL and is rendered
 * in the map's attribution control — do not remove it.
 */
export const BASEMAP = {
  url:
    env.VITE_CARTO_BASEMAP_URL ??
    'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: ['a', 'b', 'c'],
};

/** Header carrying the operator identity until real auth exists. */
export const OPERATOR_HEADER = 'X-Operator-Subject';
