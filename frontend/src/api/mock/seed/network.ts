/**
 * The simulated demo camera network.
 *
 * ⚠️  These cameras do not exist. They are fictional nodes placed on real road
 * geometry in central Bengaluru (MG Road / Halasuru / Residency Road / Cubbon /
 * Airport Road / Indiranagar 100ft). Every screen that renders this data must
 * say so — see `SimulatedNetworkNotice`.
 *
 * Lane E owns the real seed script for `roads` / `cameras` / `camera_links`.
 * When it lands, the camera codes and corridor shape here should be reconciled
 * with it so the two datasets tell the same story.
 *
 * `distance_meters` and `free_flow_time_seconds` are *computed* from the path
 * geometry and a per-corridor free-flow speed rather than typed by hand, so the
 * derived-speed maths downstream can never contradict the geometry.
 */

import { bearingDegrees, directionLabel, lineLengthMeters } from '@/lib/geo';
import { stableUuid } from '@/lib/rng';
import type {
  CameraLinkProperties,
  CameraProperties,
  CameraStatus,
  Road,
} from '@/types/domain';
import type {
  Feature,
  FeatureCollection,
  LineStringGeometry,
  PointGeometry,
  Position,
} from '@/types/geo';

/* ------------------------------------------------------------------ roads --- */

interface RoadSeed {
  road_code: string;
  name: string;
}

const ROAD_SEEDS: readonly RoadSeed[] = [
  { road_code: 'MG-RD-C1', name: 'MG Road (Trinity → Cubbon Park)' },
  { road_code: 'HAL-RD-1', name: 'Halasuru Road (Trinity → Halasuru Gate)' },
  { road_code: 'OMR-SEG-1', name: 'Old Madras Road (Halasuru → Ulsoor)' },
  { road_code: 'BRG-RD-1', name: 'Brigade Road' },
  { road_code: 'RES-RD-1', name: 'Residency Road' },
  { road_code: 'KST-CUB-1', name: 'Kasturba Road & Cubbon Road' },
  { road_code: 'ARP-RD-1', name: 'Airport Road (Trinity → Domlur)' },
  { road_code: 'IND-100FT', name: 'Indiranagar 100ft Road' },
];

export const roads: readonly Road[] = ROAD_SEEDS.map((seed) => ({
  road_id: stableUuid(`road:${seed.road_code}`),
  road_code: seed.road_code,
  name: seed.name,
  active: true,
}));

const roadByCode = new Map(roads.map((road) => [road.road_code, road]));

/* ---------------------------------------------------------------- cameras --- */

interface CameraSeed {
  camera_code: string;
  display_name: string;
  /** `[lng, lat]`, EPSG:4326. */
  location: Position;
  /** Direction the camera lens faces — it looks at oncoming traffic. */
  heading_degrees: number;
  status: CameraStatus;
}

const CAMERA_SEEDS: readonly CameraSeed[] = [
  {
    camera_code: 'CAM-01',
    display_name: 'Trinity Circle Junction',
    location: [77.6198, 12.9727],
    heading_degrees: 78,
    status: 'active',
  },
  {
    camera_code: 'CAM-02',
    display_name: 'MG Road × Brigade Road',
    location: [77.6069, 12.9748],
    heading_degrees: 96,
    status: 'active',
  },
  {
    camera_code: 'CAM-03',
    display_name: 'Anil Kumble Circle',
    location: [77.6045, 12.9752],
    heading_degrees: 104,
    status: 'active',
  },
  {
    camera_code: 'CAM-04',
    display_name: 'MG Road × Cubbon Park Gate',
    location: [77.5995, 12.9763],
    heading_degrees: 112,
    status: 'active',
  },
  {
    camera_code: 'CAM-05',
    display_name: 'Halasuru Gate',
    location: [77.6244, 12.9808],
    heading_degrees: 208,
    status: 'active',
  },
  {
    camera_code: 'CAM-06',
    display_name: 'Old Madras Road × Ulsoor Lake',
    location: [77.621, 12.9855],
    heading_degrees: 186,
    status: 'fault',
  },
  {
    camera_code: 'CAM-07',
    display_name: 'Residency Road × Richmond Circle',
    location: [77.6008, 12.966],
    heading_degrees: 74,
    status: 'active',
  },
  {
    camera_code: 'CAM-08',
    display_name: 'Brigade Road × Residency Road',
    location: [77.6065, 12.9679],
    heading_degrees: 12,
    status: 'active',
  },
  {
    camera_code: 'CAM-09',
    display_name: 'Kasturba Road × Museum Road',
    location: [77.596, 12.9718],
    heading_degrees: 156,
    status: 'active',
  },
  {
    camera_code: 'CAM-10',
    display_name: 'Cubbon Road × Infantry Road',
    location: [77.599, 12.98],
    heading_degrees: 190,
    status: 'maintenance',
  },
  {
    camera_code: 'CAM-11',
    display_name: 'Indiranagar 100ft × CMH Road',
    location: [77.6412, 12.9719],
    heading_degrees: 178,
    status: 'active',
  },
  {
    camera_code: 'CAM-12',
    display_name: 'Domlur Flyover Approach',
    location: [77.6387, 12.9608],
    heading_degrees: 348,
    status: 'active',
  },
];

/* -------------------------------------------------------------- corridors --- */

interface SegmentSeed {
  from: string;
  to: string;
  road_code: string;
  /** Posted limit, → `camera_links.speed_limit_kph`. */
  speed_limit_kph: number;
  /**
   * Uncongested average speed for this corridor. `free_flow_time_seconds` is
   * derived as `distance / free_flow_kph`, so it is always consistent with the
   * geometry. Lower than the posted limit because of junctions and signals.
   */
  free_flow_kph: number;
  /** Intermediate vertices; the two camera locations are added automatically. */
  via: Position[];
}

const SEGMENT_SEEDS: readonly SegmentSeed[] = [
  {
    from: 'CAM-01',
    to: 'CAM-02',
    road_code: 'MG-RD-C1',
    speed_limit_kph: 50,
    free_flow_kph: 34,
    via: [
      [77.616, 12.9733],
      [77.612, 12.9739],
      [77.6095, 12.9744],
    ],
  },
  {
    from: 'CAM-02',
    to: 'CAM-03',
    road_code: 'MG-RD-C1',
    speed_limit_kph: 50,
    free_flow_kph: 30,
    via: [[77.6057, 12.975]],
  },
  {
    from: 'CAM-03',
    to: 'CAM-04',
    road_code: 'MG-RD-C1',
    speed_limit_kph: 50,
    free_flow_kph: 32,
    via: [
      [77.6025, 12.9756],
      [77.6008, 12.976],
    ],
  },
  {
    from: 'CAM-01',
    to: 'CAM-05',
    road_code: 'HAL-RD-1',
    speed_limit_kph: 40,
    free_flow_kph: 28,
    via: [
      [77.6215, 12.9752],
      [77.6232, 12.978],
    ],
  },
  {
    from: 'CAM-05',
    to: 'CAM-06',
    road_code: 'OMR-SEG-1',
    speed_limit_kph: 50,
    free_flow_kph: 34,
    via: [[77.6236, 12.9828]],
  },
  {
    from: 'CAM-02',
    to: 'CAM-08',
    road_code: 'BRG-RD-1',
    speed_limit_kph: 40,
    free_flow_kph: 22,
    via: [
      [77.6072, 12.9725],
      [77.607, 12.97],
    ],
  },
  {
    from: 'CAM-08',
    to: 'CAM-07',
    road_code: 'RES-RD-1',
    speed_limit_kph: 50,
    free_flow_kph: 30,
    via: [[77.604, 12.967]],
  },
  {
    from: 'CAM-07',
    to: 'CAM-09',
    road_code: 'RES-RD-1',
    speed_limit_kph: 50,
    free_flow_kph: 32,
    via: [
      [77.5985, 12.9668],
      [77.5968, 12.9695],
    ],
  },
  {
    from: 'CAM-09',
    to: 'CAM-04',
    road_code: 'KST-CUB-1',
    speed_limit_kph: 50,
    free_flow_kph: 36,
    via: [
      [77.597, 12.974],
      [77.5982, 12.9755],
    ],
  },
  {
    from: 'CAM-04',
    to: 'CAM-10',
    road_code: 'KST-CUB-1',
    speed_limit_kph: 50,
    free_flow_kph: 34,
    via: [[77.5988, 12.978]],
  },
  {
    from: 'CAM-01',
    to: 'CAM-12',
    road_code: 'ARP-RD-1',
    speed_limit_kph: 60,
    free_flow_kph: 42,
    via: [
      [77.625, 12.97],
      [77.631, 12.966],
      [77.6355, 12.9625],
    ],
  },
  {
    from: 'CAM-12',
    to: 'CAM-11',
    road_code: 'IND-100FT',
    speed_limit_kph: 50,
    free_flow_kph: 36,
    via: [
      [77.64, 12.965],
      [77.6408, 12.969],
    ],
  },
  {
    from: 'CAM-11',
    to: 'CAM-01',
    road_code: 'OMR-SEG-1',
    speed_limit_kph: 60,
    free_flow_kph: 40,
    via: [
      [77.638, 12.974],
      [77.632, 12.976],
      [77.626, 12.9745],
    ],
  },
];

/* ---------------------------------------------------------------- builders -- */

function cameraId(code: string): string {
  return stableUuid(`camera:${code}`);
}

function linkId(from: string, to: string): string {
  return stableUuid(`camera_link:${from}->${to}`);
}

const cameraSeedByCode = new Map(CAMERA_SEEDS.map((seed) => [seed.camera_code, seed]));

function requireCameraSeed(code: string): CameraSeed {
  const seed = cameraSeedByCode.get(code);
  if (!seed) throw new Error(`Unknown camera code in segment seed: ${code}`);
  return seed;
}

/** Roads touching each camera, for tooltips. */
const roadNamesByCamera = new Map<string, Set<string>>();
for (const segment of SEGMENT_SEEDS) {
  const road = roadByCode.get(segment.road_code);
  if (!road) throw new Error(`Unknown road code in segment seed: ${segment.road_code}`);
  for (const code of [segment.from, segment.to]) {
    const set = roadNamesByCamera.get(code) ?? new Set<string>();
    set.add(road.name);
    roadNamesByCamera.set(code, set);
  }
}

export const cameraFeatures: Feature<PointGeometry, CameraProperties>[] =
  CAMERA_SEEDS.map((seed) => {
    const id = cameraId(seed.camera_code);
    return {
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: seed.location },
      properties: {
        camera_id: id,
        camera_code: seed.camera_code,
        display_name: seed.display_name,
        heading_degrees: seed.heading_degrees,
        status: seed.status,
        // Filled in by the dataset builder, which knows "now".
        last_seen_at: null,
        road_names: [...(roadNamesByCamera.get(seed.camera_code) ?? [])],
      },
    };
  });

function buildDirectedLink(
  segment: SegmentSeed,
  reverse: boolean,
): Feature<LineStringGeometry, CameraLinkProperties> {
  const fromCode = reverse ? segment.to : segment.from;
  const toCode = reverse ? segment.from : segment.to;
  const fromSeed = requireCameraSeed(fromCode);
  const toSeed = requireCameraSeed(toCode);

  const via = reverse ? [...segment.via].reverse() : segment.via;
  const coordinates: Position[] = [fromSeed.location, ...via, toSeed.location];

  const distance = Math.round(lineLengthMeters(coordinates));
  const freeFlowSeconds = Math.round(distance / (segment.free_flow_kph / 3.6));
  const bearing = bearingDegrees(fromSeed.location, toSeed.location);
  const road = roadByCode.get(segment.road_code)!;
  const id = linkId(fromCode, toCode);

  return {
    type: 'Feature',
    id,
    geometry: { type: 'LineString', coordinates },
    properties: {
      camera_link_id: id,
      from_camera_id: cameraId(fromCode),
      to_camera_id: cameraId(toCode),
      from_camera_code: fromCode,
      to_camera_code: toCode,
      road_id: road.road_id,
      road_name: road.name,
      direction_label: directionLabel(bearing),
      distance_meters: distance,
      free_flow_time_seconds: freeFlowSeconds,
      speed_limit_kph: segment.speed_limit_kph,
      active: true,
    },
  };
}

/**
 * Both directions of every corridor, matching the schema's directed
 * `camera_links` model with its `UNIQUE (from_camera_id, to_camera_id)`.
 */
export const cameraLinkFeatures: Feature<LineStringGeometry, CameraLinkProperties>[] =
  SEGMENT_SEEDS.flatMap((segment) => [
    buildDirectedLink(segment, false),
    buildDirectedLink(segment, true),
  ]);

/* --------------------------------------------------------------- accessors -- */

export const camerasCollection: FeatureCollection<PointGeometry, CameraProperties> = {
  type: 'FeatureCollection',
  features: cameraFeatures,
};

export const cameraLinksCollection: FeatureCollection<
  LineStringGeometry,
  CameraLinkProperties
> = {
  type: 'FeatureCollection',
  features: cameraLinkFeatures,
};

export const cameraByCode = new Map(
  cameraFeatures.map((feature) => [feature.properties.camera_code, feature]),
);

export const cameraById = new Map(
  cameraFeatures.map((feature) => [feature.properties.camera_id, feature]),
);

export const linkByEndpoints = new Map(
  cameraLinkFeatures.map((feature) => [
    `${feature.properties.from_camera_code}->${feature.properties.to_camera_code}`,
    feature,
  ]),
);

export const linkById = new Map(
  cameraLinkFeatures.map((feature) => [feature.properties.camera_link_id, feature]),
);

/** Outgoing links keyed by camera code — the adjacency list for route walks. */
export const outgoingLinks = new Map<
  string,
  Feature<LineStringGeometry, CameraLinkProperties>[]
>();
for (const feature of cameraLinkFeatures) {
  const list = outgoingLinks.get(feature.properties.from_camera_code) ?? [];
  list.push(feature);
  outgoingLinks.set(feature.properties.from_camera_code, list);
}

export const cameraCodes: readonly string[] = CAMERA_SEEDS.map((s) => s.camera_code);

export function findLink(
  fromCode: string,
  toCode: string,
): Feature<LineStringGeometry, CameraLinkProperties> | undefined {
  return linkByEndpoints.get(`${fromCode}->${toCode}`);
}
