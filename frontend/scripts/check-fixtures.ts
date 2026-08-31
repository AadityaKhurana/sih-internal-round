/**
 * Fixture self-check: `npm run check:fixtures`
 *
 * The mock dataset is generated, not written by hand, so it needs a guard. This
 * asserts the invariants the dashboard depends on and prints a summary. Run it
 * after touching anything under `src/api/mock/seed/`.
 */

import { congestionLevel } from '../src/lib/congestion';
import { formatDuration } from '../src/lib/time';
import { isValidPlate } from '../src/lib/plate';
import { dataset } from '../src/api/mock/seed';
import { activeIncidents, cameraWindowMetric, linkWindowMetric } from '../src/api/mock/seed/demand';
import { STORY_PLATES } from '../src/api/mock/seed/plates';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\nNetwork');
check('12 cameras', dataset.cameras.features.length === 12, `got ${dataset.cameras.features.length}`);
check('26 directed links', dataset.cameraLinks.features.length === 26, `got ${dataset.cameraLinks.features.length}`);
check(
  'every link has positive distance and free-flow time',
  dataset.cameraLinks.features.every(
    (f) => f.properties.distance_meters > 0 && f.properties.free_flow_time_seconds > 0,
  ),
);
check(
  'no self-links (schema CHECK from_camera_id <> to_camera_id)',
  dataset.cameraLinks.features.every(
    (f) => f.properties.from_camera_id !== f.properties.to_camera_id,
  ),
);
check(
  'link endpoint pairs are unique (schema UNIQUE constraint)',
  new Set(
    dataset.cameraLinks.features.map(
      (f) => `${f.properties.from_camera_id}->${f.properties.to_camera_id}`,
    ),
  ).size === dataset.cameraLinks.features.length,
);
check(
  'every link path starts and ends at its cameras',
  dataset.cameraLinks.features.every((f) => {
    const from = dataset.cameras.features.find(
      (c) => c.properties.camera_id === f.properties.from_camera_id,
    );
    const to = dataset.cameras.features.find(
      (c) => c.properties.camera_id === f.properties.to_camera_id,
    );
    const first = f.geometry.coordinates[0];
    const last = f.geometry.coordinates[f.geometry.coordinates.length - 1];
    return (
      !!from && !!to && !!first && !!last &&
      first[0] === from.geometry.coordinates[0] &&
      last[0] === to.geometry.coordinates[0]
    );
  }),
);

const distances = dataset.cameraLinks.features.map((f) => f.properties.distance_meters);
console.log(
  `    link distance range: ${Math.min(...distances)}–${Math.max(...distances)} m`,
);

console.log('\nSightings');
check('sightings generated', dataset.sightings.length > 1500, `got ${dataset.sightings.length}`);
check(
  'sightings are time-ordered',
  dataset.sightings.every(
    (s, i) => i === 0 || Date.parse(s.spotted_at) >= Date.parse(dataset.sightings[i - 1]!.spotted_at),
  ),
);
check(
  'source_event_id is unique (idempotency key)',
  new Set(dataset.sightings.map((s) => s.source_event_id)).size === dataset.sightings.length,
);
check(
  'confidences are within 0–1',
  dataset.sightings.every(
    (s) =>
      (s.ocr_confidence === null || (s.ocr_confidence >= 0 && s.ocr_confidence <= 1)) &&
      (s.detection_confidence === null ||
        (s.detection_confidence >= 0 && s.detection_confidence <= 1)),
  ),
);
check(
  'accepted sightings always have a resolved plate_id',
  dataset.sightings.every(
    (s) => s.validation_status !== 'accepted' || (s.plate_id !== null && s.normalized_plate !== null),
  ),
);
check(
  'non-accepted sightings never carry a resolved plate_id',
  dataset.sightings.every((s) => s.validation_status === 'accepted' || s.plate_id === null),
);
check(
  'no NaN timestamps',
  dataset.sightings.every((s) => Number.isFinite(Date.parse(s.spotted_at))),
);

const statusCounts = dataset.sightings.reduce<Record<string, number>>((acc, s) => {
  acc[s.validation_status] = (acc[s.validation_status] ?? 0) + 1;
  return acc;
}, {});
console.log(`    validation_status spread: ${JSON.stringify(statusCounts)}`);
check(
  'all four validation states are represented',
  ['accepted', 'pending', 'uncertain', 'conflict'].every((k) => (statusCounts[k] ?? 0) > 0),
  JSON.stringify(statusCounts),
);

console.log('\nPlates');
check('plate pool populated', dataset.plates.length > 300, `got ${dataset.plates.length}`);
check(
  'every generated plate matches an Indian series format',
  dataset.plates.every((p) => isValidPlate(p.normalized_plate)),
  dataset.plates.find((p) => !isValidPlate(p.normalized_plate))?.normalized_plate,
);
for (const [role, plate] of Object.entries(STORY_PLATES)) {
  const history = dataset.sightingsByPlate.get(plate) ?? [];
  check(`story plate ${role} (${plate}) has sightings`, history.length > 0, `got ${history.length}`);
}

console.log('\nAlerts');
check('alerts generated', dataset.alerts.length > 10, `got ${dataset.alerts.length}`);
check(
  'dedup_key is unique',
  new Set(dataset.alerts.map((a) => a.dedup_key)).size === dataset.alerts.length,
);
check(
  'blacklist alerts always cite a blacklist entry (schema shape guard)',
  dataset.alerts.every((a) => a.alert_type !== 'blacklist' || a.blacklist_entry_id !== null),
);
check(
  'route_anomaly alerts always cite a reason (schema shape guard)',
  dataset.alerts.every((a) => a.alert_type !== 'route_anomaly' || a.anomaly_reason !== null),
);
check(
  'route_anomaly alerts never cite a blacklist entry',
  dataset.alerts.every((a) => a.alert_type !== 'route_anomaly' || a.blacklist_entry_id === null),
);
check(
  'every alert points at a real sighting',
  dataset.alerts.every((a) => dataset.sightings.some((s) => s.sighting_id === a.sighting_id)),
);
check(
  'acknowledged/resolved alerts have acknowledged_by + acknowledged_at',
  dataset.alerts.every(
    (a) =>
      !['acknowledged', 'resolved'].includes(a.status) ||
      (a.acknowledged_at !== null && a.acknowledged_by !== null),
  ),
);

const byType = dataset.alerts.reduce<Record<string, number>>((acc, a) => {
  const key = a.alert_type === 'route_anomaly' ? `route_anomaly:${a.anomaly_reason}` : 'blacklist';
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});
console.log(`    alert breakdown: ${JSON.stringify(byType, null, 0)}`);
check(
  'all three anomaly reasons are represented',
  ['impossible_travel_time', 'wrong_direction', 'suspected_clone'].every(
    (r) => (byType[`route_anomaly:${r}`] ?? 0) > 0,
  ),
);
check('at least one alert is still `new`', dataset.alerts.some((a) => a.status === 'new'));

console.log('\nBlacklist');
check('blacklist entries seeded', dataset.blacklist.length >= 7, `got ${dataset.blacklist.length}`);
check(
  'active, inactive and expired statuses all present',
  ['active', 'inactive', 'expired'].every((s) => dataset.blacklist.some((e) => e.status === s)),
);
check(
  'all four severities present',
  ['low', 'medium', 'high', 'critical'].every((s) => dataset.blacklist.some((e) => e.severity === s)),
);

console.log('\nAnalytics model');
const sampleWindow = dataset.now - 10 * 60_000;
const faultMetric = cameraWindowMetric('CAM-06', sampleWindow);
check('a `fault` camera reports zero volume', faultMetric.vehicle_count === 0, JSON.stringify(faultMetric));
const activeMetric = cameraWindowMetric('CAM-01', sampleWindow);
check('an active camera reports volume', activeMetric.vehicle_count > 0, JSON.stringify(activeMetric));
check(
  'unique_plate_count never exceeds vehicle_count',
  activeMetric.unique_plate_count <= activeMetric.vehicle_count,
);

const linkMetric = linkWindowMetric('CAM-01', 'CAM-02', sampleWindow);
check(
  'link metric produces a congestion score',
  linkMetric.congestion_score !== null && linkMetric.congestion_score >= 1,
  JSON.stringify(linkMetric),
);
const faultLink = linkWindowMetric('CAM-05', 'CAM-06', sampleWindow);
check(
  'a link into a faulty camera yields no travel time (not an interpolated one)',
  faultLink.median_travel_time_seconds === null && faultLink.travel_time_sample_count === 0,
  JSON.stringify(faultLink),
);

const live = activeIncidents(dataset.now);
check('at least one incident straddles "now"', live.length > 0, `got ${live.length}`);
for (const incident of live) {
  const worst = incident.link_keys
    .map((key) => {
      const [from, to] = key.split('->');
      return linkWindowMetric(from!, to!, dataset.now).congestion_score ?? 0;
    })
    .reduce((a, b) => Math.max(a, b), 0);
  console.log(
    `    live: ${incident.label} → worst score ${worst.toFixed(2)} (${congestionLevel(worst)})`,
  );
  check(`  incident "${incident.incident_id}" visibly congests its links`, worst >= 1.4);
}

// Every congestion bucket should be reachable somewhere in the network today,
// otherwise the legend advertises colours the demo can never show.
const levelsSeen = new Set<string>();
for (let minutesAgo = 0; minutesAgo <= 24 * 60; minutesAgo += 5) {
  const at = dataset.now - minutesAgo * 60_000;
  for (const feature of dataset.cameraLinks.features) {
    const m = linkWindowMetric(
      feature.properties.from_camera_code,
      feature.properties.to_camera_code,
      at,
    );
    levelsSeen.add(congestionLevel(m.congestion_score));
  }
}
console.log(`    congestion levels reachable in 24h: ${[...levelsSeen].sort().join(', ')}`);
check(
  'every congestion bucket occurs within 24h',
  ['free', 'light', 'moderate', 'heavy', 'severe', 'unknown'].every((l) => levelsSeen.has(l)),
);

console.log('\nCoverage');
console.log(`    history: ${formatDuration((dataset.now - dataset.historyStart) / 1000)} of analytics`);
console.log(
  `    sightings: ${formatDuration((dataset.now - dataset.sightingsStart) / 1000)} materialised, ${dataset.sightings.length} rows across ${dataset.journeys.length} journeys`,
);
console.log(`    distinct plates seen: ${dataset.sightingsByPlate.size}`);

console.log(
  failures === 0
    ? '\n✅ fixture self-check passed\n'
    : `\n❌ ${failures} fixture check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
