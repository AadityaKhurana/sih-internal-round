import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useCameraLinks, useCameras, useTrajectory } from '@/api/hooks';
import { RouteIcon, WarningIcon } from '@/components/icons';
import { SimulatedNetworkNotice } from '@/components/SimulatedNetworkNotice';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  KeyValue,
  Loading,
  Switch,
  Tabs,
} from '@/components/ui';
import { MapPanel } from '@/features/map/MapPanel';
import { NetworkMap } from '@/features/map/NetworkMap';
import { PlateSearch } from '@/features/trajectory/PlateSearch';
import { PlaybackControls } from '@/features/trajectory/PlaybackControls';
import { SightingEvidence } from '@/features/trajectory/SightingEvidence';
import { TrajectoryLayer } from '@/features/trajectory/TrajectoryLayer';
import { TrajectoryTimeline } from '@/features/trajectory/TrajectoryTimeline';
import {
  resolvePlaybackPosition,
  sliceSegment,
  usePlaybackClock,
} from '@/features/trajectory/playback';
import { VALIDATION_LABEL, VALIDATION_TONE, formatCount } from '@/lib/congestion';
import { boundsOf, formatDistance, formatSpeed } from '@/lib/geo';
import { cx } from '@/lib/cx';
import { formatPlate } from '@/lib/plate';
import { formatDateTime, formatDuration, formatTime } from '@/lib/time';
import type { TrajectoryResponse } from '@/types/api';
import '@/features/trajectory/trajectory.css';

type SidePanel = 'timeline' | 'trips' | 'evidence' | 'withheld';

const SIDE_TABS = [
  { value: 'timeline', label: 'Timeline' },
  { value: 'trips', label: 'Trips' },
  { value: 'evidence', label: 'Evidence' },
  { value: 'withheld', label: 'Withheld' },
] as const;

/**
 * Plate trajectory: search a plate, see where it went, replay the run.
 *
 * The route is reconstructed from accepted sightings only, and split into trips —
 * see `frontend/API_CONTRACT.md`. Both facts are surfaced in the UI rather than
 * assumed, because an operator drawing conclusions from a movement history needs
 * to know what was excluded and where the vehicle simply stopped.
 */
export function TrajectoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const plate = searchParams.get('plate') ?? '';

  const [includeUnvalidated, setIncludeUnvalidated] = useState(true);
  const [segmentIndex, setSegmentIndex] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [panel, setPanel] = useState<SidePanel>('timeline');

  const cameras = useCameras();
  const links = useCameraLinks();

  const query = useMemo(
    () => (plate ? { plate, include_unvalidated: includeUnvalidated } : null),
    [plate, includeUnvalidated],
  );
  const trajectory = useTrajectory(query);

  // Default to the most recent trip whenever a new plate resolves.
  useEffect(() => {
    const count = trajectory.data?.segments.length ?? 0;
    setSegmentIndex(count > 0 ? count - 1 : null);
    setSelectedIndex(null);
  }, [trajectory.data]);

  const data = trajectory.data;
  const segment =
    data && segmentIndex !== null ? (data.segments[segmentIndex] ?? null) : null;

  const active = useMemo(() => {
    if (!data || !segment) return { sightings: [], hops: [] };
    return sliceSegment(segment, data.sightings, data.hops);
  }, [data, segment]);

  const startMs = segment ? Date.parse(segment.started_at) : 0;
  const endMs = segment ? Date.parse(segment.ended_at) : 1;
  const clock = usePlaybackClock(startMs, endMs);

  const position = useMemo(
    () =>
      active.sightings.length > 0
        ? resolvePlaybackPosition(active.sightings, active.hops, clock.virtualMs)
        : null,
    [active.sightings, active.hops, clock.virtualMs],
  );

  const routeBounds = useMemo(
    () =>
      active.sightings.length > 0
        ? boundsOf(active.sightings.map((sighting) => sighting.camera_location), 0.003)
        : null,
    [active.sightings],
  );

  const emphasised = useMemo(
    () => new Set(active.sightings.map((sighting) => sighting.camera_code)),
    [active.sightings],
  );

  const selectedSighting =
    selectedIndex !== null ? (active.sightings[selectedIndex] ?? null) : null;

  const submitPlate = (next: string) => {
    setSearchParams(next ? { plate: next } : {}, { replace: false });
  };

  return (
    <>
      <div className="traj-bar">
        <PlateSearch value={plate} onSubmit={submitPlate} autoFocus={plate.length === 0} />

        <Switch
          label="Include withheld sightings"
          checked={includeUnvalidated}
          onChange={(event) => setIncludeUnvalidated(event.target.checked)}
        />

        <p className="traj-bar__hint">
          Routes are rebuilt from <strong>accepted</strong> sightings, ordered by time and
          validated against the monitored link graph. Nothing is stored as a route.
        </p>

        {data ? (
          <>
            <span className="u-grow" />
            <Badge tone="accent">{formatPlate(data.plate.normalized_plate)}</Badge>
            <Badge tone="neutral">
              {data.summary.accepted_count} accepted · {data.summary.segment_count} trip
              {data.summary.segment_count === 1 ? '' : 's'}
            </Badge>
            {data.summary.anomaly_hop_count > 0 ? (
              <Badge tone="danger">
                {data.summary.anomaly_hop_count} anomalous hop
                {data.summary.anomaly_hop_count === 1 ? '' : 's'}
              </Badge>
            ) : null}
          </>
        ) : null}
      </div>

      {plate.length === 0 ? (
        <div className="page">
          <EmptyState
            icon={<RouteIcon size={26} />}
            title="Search a plate to reconstruct its route"
            body="Enter a registration number above. The dashboard finds every accepted sighting, orders them by time, validates each transition against the camera-link graph, and replays the run on the map."
          />
          <SimulatedNetworkNotice detail="Plate movements shown here come from generated observations, not real vehicles." />
        </div>
      ) : trajectory.isLoading || cameras.isLoading || links.isLoading ? (
        <div className="page">
          <Loading label={`Reconstructing the route for ${formatPlate(plate)}…`} />
        </div>
      ) : trajectory.isError ? (
        <div className="page">
          <ErrorState error={trajectory.error} onRetry={() => void trajectory.refetch()} />
        </div>
      ) : data && data.sightings.length === 0 ? (
        <div className="page">
          <EmptyState
            icon="∅"
            title={`No accepted sightings for ${formatPlate(plate)}`}
            body={
              data.excluded_sightings.length > 0
                ? `${data.excluded_sightings.length} sighting(s) exist but were withheld by validation, so no route can be drawn. See the reasons below.`
                : 'This plate has never been recorded by the simulated network.'
            }
          />
          {data.excluded_sightings.length > 0 ? (
            <Card title="Withheld sightings" subtitle="Present in the data, excluded from the route">
              <WithheldList data={data} />
            </Card>
          ) : null}
        </div>
      ) : data ? (
        <div className="traj-layout">
          <div className="traj-layout__map">
            <NetworkMap
              cameras={cameras.data?.features ?? []}
              links={links.data?.features ?? []}
              dimNetwork
              showLabels={false}
              showDirectionArrows={false}
              emphasisedCameraCodes={emphasised}
              fitBounds={routeBounds}
              overlayTopLeft={
                <MapPanel title="Trip summary">
                  <TripSummary data={data} segmentIndex={segmentIndex} />
                </MapPanel>
              }
            >
              <TrajectoryLayer
                sightings={active.sightings}
                hops={active.hops}
                position={position}
                selectedIndex={selectedIndex}
                onSelectSighting={(index) => {
                  setSelectedIndex(index);
                  setPanel('evidence');
                  const target = active.sightings[index];
                  if (target) clock.seekTo(Date.parse(target.spotted_at));
                }}
              />
            </NetworkMap>

            {segment ? (
              <PlaybackControls
                clock={clock}
                sightings={active.sightings}
                hops={active.hops}
                startMs={startMs}
                endMs={endMs}
              />
            ) : null}
          </div>

          <div className="traj-layout__side">
            <Tabs
              ariaLabel="Trajectory detail"
              value={panel}
              tabs={SIDE_TABS}
              onChange={setPanel}
            />

            {panel === 'timeline' ? (
              <TrajectoryTimeline
                sightings={active.sightings}
                hops={active.hops}
                reachedIndex={position?.reachedIndex ?? 0}
                selectedIndex={selectedIndex}
                onSelect={(index) => {
                  setSelectedIndex(index);
                  const target = active.sightings[index];
                  if (target) clock.seekTo(Date.parse(target.spotted_at));
                }}
              />
            ) : null}

            {panel === 'trips' ? (
              <div className="timeline">
                <p className="ui-field__hint" style={{ marginBottom: 'var(--sp-3)' }}>
                  A plate's history is many trips, not one route. Gaps longer than the
                  corridor could plausibly take start a new trip, so parked time is never
                  counted as travel.
                </p>
                <div className="segments" style={{ maxHeight: 'none' }}>
                  {data.segments.map((item, index) => (
                    <button
                      type="button"
                      key={item.segment_index}
                      className={cx('segment-row', index === segmentIndex && 'is-active')}
                      onClick={() => {
                        setSegmentIndex(index);
                        setSelectedIndex(null);
                      }}
                    >
                      <span className="segment-row__when">
                        {formatDateTime(item.started_at)}
                      </span>
                      <span className="segment-row__route u-truncate">
                        {item.camera_codes.join(' → ')}
                      </span>
                      <span className="u-dim" style={{ whiteSpace: 'nowrap' }}>
                        {formatDuration(item.duration_seconds)} ·{' '}
                        {formatDistance(item.distance_meters)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {panel === 'evidence' ? (
              <div className="timeline">
                {selectedSighting ? (
                  <SightingEvidence sighting={selectedSighting} />
                ) : (
                  <EmptyState
                    icon="◎"
                    title="No sighting selected"
                    body="Pick a numbered stop on the map or in the timeline to inspect the OCR evidence behind it."
                  />
                )}
              </div>
            ) : null}

            {panel === 'withheld' ? (
              <div className="timeline">
                <WithheldList data={data} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function TripSummary({
  data,
  segmentIndex,
}: {
  data: TrajectoryResponse;
  segmentIndex: number | null;
}) {
  const segment = segmentIndex !== null ? data.segments[segmentIndex] : undefined;

  return (
    <KeyValue
      rows={[
        {
          key: 'Trip',
          value: segment
            ? `${(segmentIndex ?? 0) + 1} of ${data.segments.length}`
            : '—',
        },
        {
          key: 'Started',
          value: (
            <span className="u-num">
              {segment ? formatDateTime(segment.started_at) : '—'}
            </span>
          ),
        },
        {
          key: 'Cameras',
          value: <span className="u-num">{segment?.camera_codes.length ?? 0}</span>,
        },
        {
          key: 'Distance',
          value: (
            <span className="u-num">{formatDistance(segment?.distance_meters ?? null)}</span>
          ),
        },
        {
          key: 'Duration',
          value: (
            <span className="u-num">{formatDuration(segment?.duration_seconds ?? null)}</span>
          ),
        },
        {
          key: 'Avg speed',
          value: <span className="u-num">{formatSpeed(segment?.average_speed_kph ?? null)}</span>,
        },
        {
          key: 'All history',
          value: (
            <span className="u-dim">
              {formatCount(data.summary.accepted_count)} accepted ·{' '}
              {formatDistance(data.summary.total_distance_meters)} ·{' '}
              {formatSpeed(data.summary.average_speed_kph)}
            </span>
          ),
        },
        ...(data.summary.unmonitored_hop_count > 0
          ? [
              {
                key: 'Unmonitored',
                value: (
                  <span className="u-dim">
                    {data.summary.unmonitored_hop_count} hop(s) crossed roads the network
                    does not watch
                  </span>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

function WithheldList({ data }: { data: TrajectoryResponse }) {
  if (data.excluded_sightings.length === 0) {
    return (
      <EmptyState
        icon="✓"
        title="Nothing withheld"
        body="Every sighting of this plate passed validation and contributes to the route."
      />
    );
  }

  return (
    <>
      <p className="ui-field__hint" style={{ marginBottom: 'var(--sp-3)' }}>
        These sightings exist but are excluded from the route. They are shown so the
        gaps in a reconstructed movement history are visible rather than silent.
      </p>
      <div className="u-col" style={{ gap: 'var(--sp-2)' }}>
        {data.excluded_sightings.map((sighting) => (
          <div
            key={sighting.sighting_id}
            style={{
              padding: 'var(--sp-2)',
              border: '1px solid var(--c-border)',
              borderRadius: 'var(--r-sm)',
              background: 'var(--c-surface-2)',
            }}
          >
            <div className="u-row" style={{ marginBottom: 2 }}>
              <WarningIcon size={12} />
              <span className="u-num" style={{ fontSize: 'var(--fs-xs)' }}>
                {formatTime(sighting.spotted_at)}
              </span>
              <span className="timeline__camera">{sighting.camera_code}</span>
              <Badge tone={VALIDATION_TONE[sighting.validation_status]}>
                {VALIDATION_LABEL[sighting.validation_status]}
              </Badge>
            </div>
            <p className="ui-field__hint">
              {sighting.validation_reason ?? 'No reason recorded.'}
            </p>
            <p className="object-key">
              read “{sighting.raw_plate_text ?? '—'}” → candidate “
              {sighting.normalized_plate_candidate ?? 'none'}”
            </p>
          </div>
        ))}
      </div>
    </>
  );
}

