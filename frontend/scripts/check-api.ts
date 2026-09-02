/**
 * Query-engine self-check: `npm run check:api`
 *
 * Exercises every mock endpoint the dashboard calls and asserts the behaviour the
 * UI relies on — especially the trajectory rules, which are the core query of the
 * whole product. Also times the report aggregation, since that is the one path
 * heavy enough to need a spinner.
 */

import { congestionLevel } from '../src/lib/congestion';
import { formatDuration } from '../src/lib/time';
import { DAY_MS, HOUR_MS } from '../src/lib/time';
import * as api from '../src/api/mock/queries';
import { dataset } from '../src/api/mock/seed';
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

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

const now = dataset.now;

/* -------------------------------------------------------------------- network */

console.log('\nNetwork endpoints');
check('GET /cameras returns a FeatureCollection', api.getCameras().type === 'FeatureCollection');
check('GET /camera-links returns a FeatureCollection', api.getCameraLinks().type === 'FeatureCollection');
console.log(`    monitored corridor length: ${(api.networkLengthMeters() / 1000).toFixed(2)} km`);

/* --------------------------------------------------------------- plate search */

console.log('\nPlate search');
const suggestions = api.searchPlates('KA0');
check('prefix search returns matches', suggestions.length > 0, `got ${suggestions.length}`);
check(
  'prefix matches are ranked ahead of substring matches',
  suggestions[0]?.normalized_plate.startsWith('KA0') === true,
  suggestions[0]?.normalized_plate,
);
check('a one-character query returns nothing', api.searchPlates('K').length === 0);
const stolenSuggestion = api.searchPlates(STORY_PLATES.stolen);
check(
  'a blacklisted plate is flagged in search results',
  stolenSuggestion[0]?.is_blacklisted === true,
  JSON.stringify(stolenSuggestion[0]),
);

/* ---------------------------------------------------------------- trajectory */

console.log('\nTrajectory');
const commuter = api.getTrajectory({ plate: STORY_PLATES.commuter });
check('commuter trajectory has multiple sightings', commuter.sightings.length >= 4, `got ${commuter.sightings.length}`);
check('hop count is one less than sighting count (or fewer)', commuter.hops.length <= commuter.sightings.length - 1);
check(
  'sightings are strictly time-ordered',
  commuter.sightings.every(
    (s, i) => i === 0 || Date.parse(s.spotted_at) >= Date.parse(commuter.sightings[i - 1]!.spotted_at),
  ),
);
check(
  'only accepted sightings form the route',
  commuter.sightings.every((s) => s.validation_status === 'accepted'),
);
check(
  'every valid hop carries link geometry, distance and a speed',
  commuter.hops
    .filter((h) => h.hop_status === 'valid')
    .every(
      (h) =>
        h.path !== null &&
        h.distance_meters !== null &&
        h.camera_link_id !== null &&
        h.implied_speed_kph !== null,
    ),
);
check(
  'summary totals agree with the hop list',
  commuter.summary.total_distance_meters ===
    Math.round(commuter.hops.reduce((sum, h) => sum + (h.distance_meters ?? 0), 0)),
);
console.log(
  `    ${STORY_PLATES.commuter}: ${commuter.summary.accepted_count} accepted over ${commuter.summary.segment_count} trips, ${commuter.summary.distinct_camera_count} cameras, ${(commuter.summary.total_distance_meters / 1000).toFixed(2)} km, avg ${commuter.summary.average_speed_kph?.toFixed(1) ?? '—'} km/h`,
);

/* Trip segmentation: a plate's whole history is many trips, not one route. */
check(
  'a frequent plate is split into multiple trips',
  commuter.summary.segment_count > 1,
  `got ${commuter.summary.segment_count}`,
);
check(
  'every accepted sighting belongs to exactly one segment',
  commuter.segments.reduce((sum, s) => sum + s.sighting_ids.length, 0) ===
    commuter.sightings.length,
);
check(
  'segments do not overlap in time',
  commuter.segments.every(
    (s, i) => i === 0 || Date.parse(s.started_at) > Date.parse(commuter.segments[i - 1]!.ended_at),
  ),
);
check(
  'no hop spans a trip break',
  commuter.hops.every((hop) =>
    commuter.segments.some(
      (segment) =>
        segment.sighting_ids.includes(hop.from_sighting_id) &&
        segment.sighting_ids.includes(hop.to_sighting_id),
    ),
  ),
);
check(
  'average speed is physically plausible for road traffic',
  commuter.summary.average_speed_kph !== null &&
    commuter.summary.average_speed_kph > 4 &&
    commuter.summary.average_speed_kph < 90,
  `${commuter.summary.average_speed_kph?.toFixed(1)} km/h`,
);
check(
  'per-segment average speeds are plausible where measured',
  commuter.segments
    .filter((s) => s.average_speed_kph !== null && s.distance_meters > 0)
    .every((s) => s.average_speed_kph! > 2 && s.average_speed_kph! < 130),
  JSON.stringify(
    commuter.segments.map((s) => s.average_speed_kph?.toFixed(1) ?? null),
  ),
);
check(
  'travel time excludes the gaps between trips',
  commuter.summary.total_duration_seconds <
    (Date.parse(commuter.summary.last_seen_at!) -
      Date.parse(commuter.summary.first_seen_at!)) /
      1000,
);
console.log(
  `    trips: ${commuter.segments
    .map((s) => `${s.camera_codes.length} cams / ${formatDuration(s.duration_seconds)}`)
    .slice(0, 5)
    .join(', ')}${commuter.segments.length > 5 ? ', …' : ''}`,
);

const impossible = api.getTrajectory({ plate: STORY_PLATES.impossible });
const impossibleHop = impossible.hops.find((h) => h.hop_status === 'impossible_travel_time');
check('scripted impossible-travel hop is detected', impossibleHop !== undefined);
if (impossibleHop) {
  check(
    'the impossible hop is faster than the link minimum',
    impossibleHop.travel_time_seconds < (impossibleHop.free_flow_time_seconds ?? 0) * 0.6,
    `${impossibleHop.travel_time_seconds}s vs free flow ${impossibleHop.free_flow_time_seconds}s`,
  );
  console.log(
    `    impossible hop: ${impossibleHop.from_camera_code}→${impossibleHop.to_camera_code} in ${impossibleHop.travel_time_seconds}s → ${impossibleHop.implied_speed_kph?.toFixed(0)} km/h`,
  );
}

const wrongWay = api.getTrajectory({ plate: STORY_PLATES.wrongWay });
check(
  'scripted wrong-direction hop is detected',
  wrongWay.hops.some((h) => h.hop_status === 'wrong_direction'),
  JSON.stringify(wrongWay.hops.map((h) => h.hop_status)),
);

const clone = api.getTrajectory({ plate: STORY_PLATES.clone });
check(
  'the clone pair produces a `no_link` hop (no route exists)',
  clone.hops.some((h) => h.hop_status === 'no_link'),
  JSON.stringify(clone.hops.map((h) => h.hop_status)),
);
check(
  '`no_link` hops carry no geometry or distance',
  clone.hops
    .filter((h) => h.hop_status === 'no_link')
    .every((h) => h.path === null && h.distance_meters === null && h.camera_link_id === null),
);

const contested = api.getTrajectory({ plate: STORY_PLATES.contested });
check(
  'non-accepted sightings are returned separately, not dropped',
  contested.excluded_sightings.length > 0,
  `excluded ${contested.excluded_sightings.length}`,
);
check(
  'every excluded sighting explains itself',
  contested.excluded_sightings.every((s) => s.validation_reason !== null),
);
check(
  'include_unvalidated=false suppresses the excluded list',
  api.getTrajectory({ plate: STORY_PLATES.contested, include_unvalidated: false })
    .excluded_sightings.length === 0,
);

const windowed = api.getTrajectory({
  plate: STORY_PLATES.commuter,
  from: iso(now - 2 * HOUR_MS),
  to: iso(now),
});
check(
  'a time window narrows the result',
  windowed.sightings.length <= commuter.sightings.length,
  `${windowed.sightings.length} vs ${commuter.sightings.length}`,
);
check('an unknown plate returns an empty trajectory rather than an error', api.getTrajectory({ plate: 'ZZ99ZZ9999' }).sightings.length === 0);

/* ----------------------------------------------------------------- sightings */

console.log('\nSightings');
const page1 = api.getSightings({ limit: 20, offset: 0 });
const page2 = api.getSightings({ limit: 20, offset: 20 });
check('pagination returns the requested page size', page1.items.length === 20);
check('pages do not overlap', !page1.items.some((a) => page2.items.some((b) => a.sighting_id === b.sighting_id)));
check('total exceeds one page', page1.total > 20);
check(
  'results are newest-first',
  page1.items.every((s, i) => i === 0 || Date.parse(s.spotted_at) <= Date.parse(page1.items[i - 1]!.spotted_at)),
);
const filtered = api.getSightings({ camera_code: 'CAM-02', validation_status: ['accepted'] });
check(
  'camera + status filters both apply',
  filtered.items.every((s) => s.camera_code === 'CAM-02' && s.validation_status === 'accepted'),
);

/* -------------------------------------------------------------------- alerts */

console.log('\nAlerts');
const allAlerts = api.getAlerts({ limit: 500 });
check('alert list is populated', allAlerts.total > 10, `got ${allAlerts.total}`);
check(
  'alerts are newest-first',
  allAlerts.items.every((a, i) => i === 0 || Date.parse(a.created_at) <= Date.parse(allAlerts.items[i - 1]!.created_at)),
);
const onlyAnomalies = api.getAlerts({ alert_type: ['route_anomaly'], limit: 500 });
check('type filter applies', onlyAnomalies.items.every((a) => a.alert_type === 'route_anomaly'));
const criticalOnly = api.getAlerts({ severity: ['critical'], limit: 500 });
check('severity filter applies and excludes anomalies (which have none)', criticalOnly.items.every((a) => a.severity === 'critical'));

const counts = api.getAlertCounts({});
check(
  'counts total matches the unfiltered list',
  counts.total === allAlerts.total,
  `${counts.total} vs ${allAlerts.total}`,
);
check(
  'counts split by type sum to the total',
  counts.blacklist + counts.route_anomaly === counts.total,
);

const target = allAlerts.items.find((a) => a.status !== 'resolved');
if (target) {
  const acked = api.acknowledgeAlert(target.alert_id, {
    acknowledged_by: 'test.operator',
    resolution_notes: 'checked by the self-check script',
    status: 'acknowledged',
  });
  check('acknowledge writes status', acked.status === 'acknowledged');
  check('acknowledge writes acknowledged_by', acked.acknowledged_by === 'test.operator');
  check('acknowledge writes acknowledged_at', acked.acknowledged_at !== null);
  check(
    'acknowledgement persists in the dataset',
    api.getAlerts({ limit: 500 }).items.find((a) => a.alert_id === target.alert_id)?.status ===
      'acknowledged',
  );
}
let notFound = false;
try {
  api.acknowledgeAlert('does-not-exist', { acknowledged_by: 'x' });
} catch (error) {
  notFound = error instanceof api.MockApiError && error.status === 404;
}
check('acknowledging a missing alert raises 404', notFound);

/* ----------------------------------------------------------------- blacklist */

console.log('\nBlacklist');
const activeOnly = api.getBlacklist({ status: ['active'] });
check('status filter applies', activeOnly.items.every((e) => e.status === 'active'));
check('entries carry sighting activity', activeOnly.items.some((e) => (e.sighting_count ?? 0) > 0));

const created = api.createBlacklistEntry({
  plate: 'ka 53 zz 4321',
  reason: 'self-check entry',
  severity: 'high',
  added_by: 'test.operator',
});
check('create normalises the plate', created.normalized_plate === 'KA53ZZ4321');
check('create defaults to active', created.status === 'active');
check(
  'created entry appears in listings',
  api.getBlacklist({ q: 'KA53ZZ4321' }).items.length === 1,
);

let conflict = false;
try {
  api.createBlacklistEntry({
    plate: 'KA53ZZ4321',
    reason: 'duplicate',
    severity: 'low',
    added_by: 'test.operator',
  });
} catch (error) {
  conflict = error instanceof api.MockApiError && error.status === 409;
}
check('a second active entry for the same plate is rejected with 409', conflict);

let validation = false;
try {
  api.createBlacklistEntry({ plate: 'KA53ZZ4321', reason: '   ', severity: 'low', added_by: 'x' });
} catch (error) {
  validation = error instanceof api.MockApiError && error.status === 422;
}
check('an empty reason is rejected with 422', validation);

const deactivated = api.updateBlacklistEntry(created.blacklist_entry_id, { status: 'inactive' });
check('update changes status', deactivated.status === 'inactive');
check(
  'deactivating frees the plate for a new entry',
  api.createBlacklistEntry({
    plate: 'KA53ZZ4321',
    reason: 're-added after review',
    severity: 'medium',
    added_by: 'test.operator',
  }).status === 'active',
);

/* ---------------------------------------------------------------- analytics */

console.log('\nAnalytics');
const window1h = { from: iso(now - HOUR_MS), to: iso(now) };

const nodes = api.getNodeMetrics(window1h);
check('every camera appears in node metrics', nodes.nodes.length === dataset.cameras.features.length);
check('max_vehicle_count matches the node list', nodes.max_vehicle_count === Math.max(...nodes.nodes.map((n) => n.vehicle_count)));
check(
  'the faulty camera reports zero, and is not hidden',
  nodes.nodes.find((n) => n.camera_code === 'CAM-06')?.vehicle_count === 0,
);
check(
  'unique plates never exceed vehicles at any node',
  nodes.nodes.every((n) => n.unique_plate_count <= n.vehicle_count),
);

const links = api.getLinkCongestion(window1h);
check('every link appears in congestion output', links.links.length === dataset.cameraLinks.features.length);
check(
  'derived speed is present exactly when a median travel time is',
  links.links.every((l) => (l.median_travel_time_seconds === null) === (l.derived_speed_kph === null)),
);
check(
  'congestion score is present exactly when a median travel time is',
  links.links.every((l) => (l.median_travel_time_seconds === null) === (l.congestion_score === null)),
);
check(
  'derived speed equals distance / median travel time',
  links.links
    .filter((l) => l.derived_speed_kph !== null)
    .every(
      (l) =>
        Math.abs(
          l.derived_speed_kph! - (l.distance_meters / l.median_travel_time_seconds!) * 3.6,
        ) < 0.01,
    ),
);
check('every link carries geometry for the overlay', links.links.every((l) => l.path !== null));
check('network average congestion is reported', links.network_avg_congestion_score !== null);

const worst = [...links.links]
  .filter((l) => l.congestion_score !== null)
  .sort((a, b) => (b.congestion_score ?? 0) - (a.congestion_score ?? 0))[0];
console.log(
  `    worst link in the last hour: ${worst?.from_camera_code}→${worst?.to_camera_code} score ${worst?.congestion_score} (${congestionLevel(worst?.congestion_score ?? null)}), ${worst?.derived_speed_kph?.toFixed(1)} km/h from ${worst?.travel_time_sample_count} samples`,
);

const trend = api.getFlowTrends({ ...window1h, scope: 'network', bucket_minutes: 15 });
check('network trend produces buckets', trend.points.length > 0, `got ${trend.points.length}`);
check('trend buckets are ordered', trend.points.every((p, i) => i === 0 || Date.parse(p.window_start) > Date.parse(trend.points[i - 1]!.window_start)));
check('trend bucket size is honoured', trend.bucket_minutes === 15);

const linkId = dataset.cameraLinks.features[0]!.properties.camera_link_id;
const linkTrend = api.getFlowTrends({ ...window1h, scope: 'link', target_id: linkId, bucket_minutes: 5 });
check('link-scoped trend resolves a label', linkTrend.target_label.includes('→'));
check('link-scoped trend reports congestion', linkTrend.points.some((p) => p.congestion_score !== null));

const cameraTrend = api.getFlowTrends({ ...window1h, scope: 'camera', target_id: 'CAM-01' });
check('camera-scoped trend resolves a label', cameraTrend.target_label.startsWith('CAM-01'));

let badScope = false;
try {
  api.getFlowTrends({ ...window1h, scope: 'camera', target_id: 'CAM-99' });
} catch (error) {
  badScope = error instanceof api.MockApiError && error.status === 404;
}
check('an unknown camera in a trend query raises 404', badScope);

const od = api.getOriginDestination({ from: iso(now - 2 * DAY_MS), to: iso(now) });
check('O-D pairs are produced', od.pairs.length > 0, `got ${od.pairs.length}`);
check('O-D pairs never have identical origin and destination', od.pairs.every((p) => p.from_camera_code !== p.to_camera_code));
check('O-D pairs are ordered by volume', od.pairs.every((p, i) => i === 0 || p.journey_count <= od.pairs[i - 1]!.journey_count));
check('O-D share is a sane percentage', od.pairs.every((p) => p.share_pct >= 0 && p.share_pct <= 100));
console.log(
  `    top O-D: ${od.pairs[0]?.from_camera_code}→${od.pairs[0]?.to_camera_code}, ${od.pairs[0]?.journey_count} journeys (${od.pairs[0]?.share_pct}% of that origin), median ${formatDuration(od.pairs[0]?.median_travel_time_seconds ?? null)}`,
);

/* ------------------------------------------------------------------ reports */

console.log('\nReports');
const weekPeriods = api.getReportPeriods('week');
check('weekly periods are offered', weekPeriods.periods.length > 1, `got ${weekPeriods.periods.length}`);
const monthPeriods = api.getReportPeriods('month');
check('monthly periods are offered', monthPeriods.periods.length > 0, `got ${monthPeriods.periods.length}`);

const t0 = performance.now();
const weekly = api.getReport('week');
const weeklyMs = performance.now() - t0;
check('weekly report has a summary', weekly.summary.total_sightings > 0);
check('weekly report has a comparison period', weekly.comparison !== null);
check('weekly report ranks worst links', weekly.worst_links.length > 0);
check(
  'worst links are ordered by congestion',
  weekly.worst_links.every((l, i) => i === 0 || (l.congestion_score ?? 0) <= (weekly.worst_links[i - 1]!.congestion_score ?? 0)),
);
check('hourly profile is a full 7×24 grid', weekly.hourly_profile.length === 168, `got ${weekly.hourly_profile.length}`);
check('daily series has entries', weekly.daily_series.length > 0);
check('alerts are broken down by type', weekly.alerts_by_type.length > 0);
check('total delay is reported', weekly.summary.total_delay_hours !== null);
console.log(
  `    ${weekly.period.label}: ${weekly.summary.total_sightings.toLocaleString()} sightings, avg score ${weekly.summary.avg_congestion_score}, ${weekly.summary.alert_count} alerts, ${weekly.summary.total_delay_hours}h delay`,
);
console.log(`    weekly aggregation took ${weeklyMs.toFixed(0)} ms (cold)`);

const t1 = performance.now();
api.getReport('week');
console.log(`    cached re-read took ${(performance.now() - t1).toFixed(1)} ms`);

const t2 = performance.now();
const monthly = api.getReport('month');
const monthlyMs = performance.now() - t2;
check('monthly report aggregates', monthly.summary.total_sightings > 0);
check(
  'monthly volume exceeds weekly (longer period)',
  monthly.summary.total_sightings > weekly.summary.total_sightings,
);
console.log(`    monthly aggregation took ${monthlyMs.toFixed(0)} ms (cold)`);
check('monthly aggregation stays under 3 s', monthlyMs < 3000, `${monthlyMs.toFixed(0)} ms`);

let badPeriod = false;
try {
  api.getReport('week', '1999-W99');
} catch (error) {
  badPeriod = error instanceof api.MockApiError && error.status === 422;
}
check('an unknown period raises 422', badPeriod);

console.log(
  failures === 0 ? '\n✅ query-engine self-check passed\n' : `\n❌ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
