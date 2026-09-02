import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useCameraLinks, useCameras, useLinkCongestion, useNodeMetrics } from '@/api/hooks';
import { CameraIcon, LayersIcon, WarningIcon } from '@/components/icons';
import {
  Badge,
  ErrorState,
  Legend,
  Loading,
  SegmentedControl,
  Switch,
} from '@/components/ui';
import { useLive } from '@/features/live/LiveProvider';
import { usePulses } from '@/features/live/usePulses';
import { MapPanel } from '@/features/map/MapPanel';
import { NetworkMap } from '@/features/map/NetworkMap';
import { CAMERA_STATUS_HEX, CONGESTION_LEGEND, congestionColorHex } from '@/lib/congestion';
import { boundsOf, toLatLng } from '@/lib/geo';
import { formatPlate } from '@/lib/plate';
import { formatShortTime, formatTime } from '@/lib/time';
import type { LinkCongestion, NodeMetric } from '@/types/domain';

type MapView = 'network' | 'congestion' | 'load';

const VIEW_OPTIONS = [
  { value: 'network', label: 'Network', title: 'Camera status and corridor layout' },
  {
    value: 'congestion',
    label: 'Congestion',
    title: 'Link colour by travel time against free flow',
  },
  { value: 'load', label: 'Node load', title: 'Camera marker size and colour by volume' },
] as const;

const WINDOW_MINUTES = 60;

const CAMERA_STATUS_LEGEND = [
  { color: CAMERA_STATUS_HEX.active, label: 'Active' },
  { color: CAMERA_STATUS_HEX.maintenance, label: 'Maintenance — partial capture' },
  { color: CAMERA_STATUS_HEX.fault, label: 'Fault — no data' },
  { color: CAMERA_STATUS_HEX.inactive, label: 'Inactive' },
];

/**
 * The live operations map.
 *
 * Three views over the same geography, because they answer different questions:
 * where the cameras are and whether they are healthy; how badly each corridor is
 * running; and which junctions are carrying the volume. Switching view changes the
 * encoding, never the geometry, so an operator never has to re-orient.
 */
export function MapPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [view, setView] = useState<MapView>('network');
  const [showArrows, setShowArrows] = useState(true);
  const [showHeadings, setShowHeadings] = useState(true);
  const [showLabels, setShowLabels] = useState(true);

  const cameras = useCameras();
  const links = useCameraLinks();
  const pulses = usePulses();
  const { liveSightings, state: liveState } = useLive();

  // Analytics windows are anchored to a whole 5-minute boundary so the query key
  // is stable and the result is cacheable, rather than changing every render.
  const window = useMemo(() => {
    const to = Math.floor(Date.now() / (5 * 60_000)) * (5 * 60_000);
    return {
      from: new Date(to - WINDOW_MINUTES * 60_000).toISOString(),
      to: new Date(to).toISOString(),
    };
  }, []);

  const congestion = useLinkCongestion(window, view === 'congestion');
  const nodeMetrics = useNodeMetrics(window, view === 'load' || view === 'congestion');

  const selectedCameraCode = searchParams.get('camera');

  const cameraFeatures = cameras.data?.features ?? [];
  const linkFeatures = links.data?.features ?? [];

  const selectedCamera = useMemo(
    () =>
      cameraFeatures.find(
        (feature) => feature.properties.camera_code === selectedCameraCode,
      ) ?? null,
    [cameraFeatures, selectedCameraCode],
  );

  const congestionById = useMemo(() => {
    const map = new Map<string, LinkCongestion>();
    for (const link of congestion.data?.links ?? []) {
      map.set(link.camera_link_id, link);
    }
    return map;
  }, [congestion.data]);

  const nodeMetricsById = useMemo(() => {
    const map = new Map<string, NodeMetric>();
    for (const node of nodeMetrics.data?.nodes ?? []) map.set(node.camera_id, node);
    return map;
  }, [nodeMetrics.data]);

  // Fit to the whole network once it loads; after that the operator owns the view.
  const initialBounds = useMemo(
    () =>
      cameraFeatures.length > 0
        ? boundsOf(cameraFeatures.map((feature) => feature.geometry.coordinates))
        : null,
    [cameraFeatures],
  );

  const worstLinks = useMemo(
    () =>
      [...(congestion.data?.links ?? [])]
        .filter((link) => link.congestion_score !== null)
        .sort((a, b) => (b.congestion_score ?? 0) - (a.congestion_score ?? 0))
        .slice(0, 5),
    [congestion.data],
  );

  const activeCameras = cameraFeatures.filter(
    (feature) => feature.properties.status === 'active',
  ).length;
  const faultyCameras = cameraFeatures.filter(
    (feature) =>
      feature.properties.status === 'fault' || feature.properties.status === 'inactive',
  ).length;

  if (cameras.isLoading || links.isLoading) {
    return (
      <div className="page">
        <Loading label="Loading the camera network…" />
      </div>
    );
  }

  if (cameras.isError || links.isError) {
    return (
      <div className="page">
        <ErrorState
          error={cameras.error ?? links.error}
          onRetry={() => {
            void cameras.refetch();
            void links.refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="page page--flush">
      <NetworkMap
        cameras={cameraFeatures}
        links={linkFeatures}
        linkColorMode={view === 'congestion' ? 'congestion' : 'network'}
        cameraColorMode={view === 'load' ? 'load' : 'status'}
        {...(view === 'congestion' ? { congestionById } : {})}
        nodeMetricsById={nodeMetricsById}
        maxVehicleCount={nodeMetrics.data?.max_vehicle_count ?? 0}
        showDirectionArrows={showArrows}
        showHeadings={showHeadings}
        showLabels={showLabels}
        selectedCameraId={selectedCamera?.properties.camera_id ?? null}
        pulses={pulses}
        fitBounds={initialBounds}
        flyTo={selectedCamera ? toLatLng(selectedCamera.geometry.coordinates) : null}
        onSelectCamera={(camera) => {
          const code = camera.properties.camera_code;
          setSearchParams(
            code === selectedCameraCode ? {} : { camera: code },
            { replace: true },
          );
        }}
        onShowTrend={(code) => navigate(`/analytics?camera=${encodeURIComponent(code)}`)}
        overlayTopLeft={
          <MapPanel tight>
            <div className="layer-switch">
              <SegmentedControl
                ariaLabel="Map view"
                value={view}
                options={VIEW_OPTIONS}
                onChange={(next) => setView(next)}
              />
              <div className="map-status">
                <span className="map-status__item">
                  <CameraIcon size={12} />
                  <span className="map-status__value">{activeCameras}</span> active
                </span>
                {faultyCameras > 0 ? (
                  <span className="map-status__item" style={{ color: 'var(--c-danger)' }}>
                    <WarningIcon size={12} />
                    <span className="map-status__value">{faultyCameras}</span> down
                  </span>
                ) : null}
                <span className="map-status__item">
                  <LayersIcon size={12} />
                  <span className="map-status__value">{linkFeatures.length}</span> links
                </span>
              </div>
            </div>
          </MapPanel>
        }
        overlayTopRight={
          <MapPanel title="Layers" tight>
            <div className="layer-switch">
              <Switch
                label="Direction arrows"
                checked={showArrows}
                onChange={(event) => setShowArrows(event.target.checked)}
              />
              <Switch
                label="Camera facing"
                checked={showHeadings}
                onChange={(event) => setShowHeadings(event.target.checked)}
              />
              <Switch
                label="Camera labels"
                checked={showLabels}
                onChange={(event) => setShowLabels(event.target.checked)}
              />
            </div>
          </MapPanel>
        }
        overlayBottomLeft={
          <MapPanel
            title={view === 'congestion' ? 'Travel time vs free flow' : 'Camera status'}
          >
            <Legend
              items={view === 'congestion' ? CONGESTION_LEGEND : CAMERA_STATUS_LEGEND}
            />
            {view === 'congestion' ? (
              <p
                className="ui-field__hint"
                style={{ marginTop: 'var(--sp-2)', maxWidth: '30ch' }}
              >
                Last {WINDOW_MINUTES} min. Both carriageways are drawn separately;
                a link with no matched journeys is grey, not green.
              </p>
            ) : null}
            {view === 'load' ? (
              <p
                className="ui-field__hint"
                style={{ marginTop: 'var(--sp-2)', maxWidth: '30ch' }}
              >
                Marker size and colour scale with vehicles counted in the last{' '}
                {WINDOW_MINUTES} min. Faulty cameras keep their status colour.
              </p>
            ) : null}
          </MapPanel>
        }
        overlayBottomRight={
          view === 'congestion' ? (
            <CongestionCallout links={worstLinks} loading={congestion.isLoading} />
          ) : (
            <LiveFeedCallout
              sightings={liveSightings}
              connected={liveState === 'open' || liveState === 'mock'}
            />
          )
        }
      />
    </div>
  );
}

function CongestionCallout({
  links,
  loading,
}: {
  links: LinkCongestion[];
  loading: boolean;
}) {
  return (
    <MapPanel title="Worst corridors now" tight>
      {loading ? (
        <div style={{ padding: 'var(--sp-2)' }}>
          <Loading label="Aggregating…" />
        </div>
      ) : links.length === 0 ? (
        <p className="incident">No matched journeys in this window.</p>
      ) : (
        links.map((link) => (
          <div className="incident" key={link.camera_link_id}>
            <span
              className="incident__icon"
              style={{
                color: congestionColorHex(
                  link.congestion_score !== null && link.congestion_score >= 1.8
                    ? 'severe'
                    : 'moderate',
                ),
              }}
            >
              <WarningIcon size={13} />
            </span>
            <span>
              <strong className="u-num">
                {link.from_camera_code} → {link.to_camera_code}
              </strong>{' '}
              <span className="u-dim">{link.direction_label ?? ''}</span>
              <br />
              {link.congestion_score?.toFixed(2)}× free flow ·{' '}
              {link.derived_speed_kph?.toFixed(0)} km/h
              <br />
              <span className="u-dim">
                {link.road_name ?? 'corridor'} · {link.travel_time_sample_count} matched
                journeys
              </span>
            </span>
          </div>
        ))
      )}
    </MapPanel>
  );
}

function LiveFeedCallout({
  sightings,
  connected,
}: {
  sightings: ReturnType<typeof useLive>['liveSightings'];
  connected: boolean;
}) {
  return (
    <MapPanel
      title="Live sightings"
      tight
      actions={
        <Badge tone={connected ? 'ok' : 'warn'} dot pulse={connected}>
          {connected ? 'streaming' : 'offline'}
        </Badge>
      }
    >
      {sightings.length === 0 ? (
        <p className="map-status" style={{ padding: 'var(--sp-2)' }}>
          Waiting for the first frame…
        </p>
      ) : (
        <div className="ticker">
          {sightings.slice(0, 7).map((sighting, index) => (
            <div
              key={sighting.sighting_id}
              className={index === 0 ? 'ticker__row is-fresh' : 'ticker__row'}
              title={`${sighting.camera_display_name} · ${formatTime(sighting.spotted_at)}`}
            >
              <span className="ticker__time">
                {formatShortTime(sighting.spotted_at)}
              </span>
              <span className="ticker__plate u-truncate">
                {formatPlate(sighting.normalized_plate)}
              </span>
              <span className="ticker__camera">{sighting.camera_code}</span>
            </div>
          ))}
        </div>
      )}
    </MapPanel>
  );
}
