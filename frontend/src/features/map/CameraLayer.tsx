import { Fragment, useMemo } from 'react';
import { CircleMarker, Pane, Polyline, Popup, Tooltip } from 'react-leaflet';

import {
  CAMERA_STATUS_HEX,
  CAMERA_STATUS_TONE,
  congestionColorHex,
  formatCount,
  formatPercentDelta,
} from '@/lib/congestion';
import { destinationPoint, formatCoords, formatHeading, toLatLng } from '@/lib/geo';
import { formatRelative } from '@/lib/time';
import { Badge, Button, KeyValue } from '@/components/ui';
import type { CameraProperties, NodeMetric } from '@/types/domain';
import type { Feature, PointGeometry } from '@/types/geo';
import { MAP_PANES } from './panes';

export type CameraColorMode = 'status' | 'load';

export interface CameraLayerProps {
  cameras: Feature<PointGeometry, CameraProperties>[];
  /** Node metrics keyed by `camera_id`, for load sizing/colouring. */
  metricsById?: Map<string, NodeMetric>;
  /** Normaliser for load mode — the busiest node in the current window. */
  maxVehicleCount?: number;
  colorMode?: CameraColorMode;
  selectedCameraId?: string | null;
  /**
   * Camera code → pulse generation. The generation is part of the React key, so
   * a second sighting at the same camera restarts the CSS animation instead of
   * it playing once and never again.
   */
  pulses?: ReadonlyMap<string, number>;
  /** Camera codes to emphasise (e.g. the cameras on a trajectory). */
  emphasisedCameraCodes?: ReadonlySet<string>;
  onSelectCamera?: (camera: Feature<PointGeometry, CameraProperties>) => void;
  onShowTrend?: (cameraCode: string) => void;
  showHeadings?: boolean;
  showLabels?: boolean;
  zoom: number;
}

/** Load ramp reuses the congestion colours so one legend covers both. */
function loadColor(share: number): string {
  if (share >= 0.85) return congestionColorHex('severe');
  if (share >= 0.65) return congestionColorHex('heavy');
  if (share >= 0.45) return congestionColorHex('moderate');
  if (share >= 0.22) return congestionColorHex('light');
  return congestionColorHex('free');
}

export function CameraLayer({
  cameras,
  metricsById,
  maxVehicleCount = 0,
  colorMode = 'status',
  selectedCameraId = null,
  pulses,
  emphasisedCameraCodes,
  onSelectCamera,
  onShowTrend,
  showHeadings = true,
  showLabels = true,
  zoom,
}: CameraLayerProps) {
  const headingMeters = useMemo(() => Math.max(25, 2 ** (17 - zoom) * 45), [zoom]);
  // Labels only once there is room for them; below this they overlap into mush.
  const labelsVisible = showLabels && zoom >= 14;

  const rendered = useMemo(
    () =>
      cameras.map((camera) => {
        const props = camera.properties;
        const metric = metricsById?.get(props.camera_id) ?? null;
        const offline = props.status === 'fault' || props.status === 'inactive';

        const share =
          maxVehicleCount > 0 && metric ? metric.vehicle_count / maxVehicleCount : 0;

        // In load mode a node with no data must not read as "quiet" — a camera
        // that is down or has no reading shows grey, so the ramp's red always
        // means peak volume and never collides with a fault.
        const color =
          colorMode === 'load'
            ? offline || !metric
              ? CAMERA_STATUS_HEX.inactive
              : loadColor(share)
            : CAMERA_STATUS_HEX[props.status];

        const baseRadius = colorMode === 'load' ? 6 + share * 12 : 7;
        const emphasised = emphasisedCameraCodes?.has(props.camera_code) ?? false;

        return {
          camera,
          metric,
          offline,
          color,
          radius: selectedCameraId === props.camera_id ? baseRadius + 3 : baseRadius,
          emphasised,
          selected: selectedCameraId === props.camera_id,
          share,
          heading:
            showHeadings && props.heading_degrees !== null
              ? [
                  toLatLng(camera.geometry.coordinates),
                  toLatLng(
                    destinationPoint(
                      camera.geometry.coordinates,
                      props.heading_degrees,
                      headingMeters,
                    ),
                  ),
                ]
              : null,
        };
      }),
    [
      cameras,
      metricsById,
      maxVehicleCount,
      colorMode,
      selectedCameraId,
      emphasisedCameraCodes,
      showHeadings,
      headingMeters,
    ],
  );

  return (
    <>
      {/* Live pulses sit under the nodes so they read as an expanding halo. */}
      <Pane name={MAP_PANES.pulses.name} style={{ zIndex: MAP_PANES.pulses.zIndex }}>
        {rendered
          .filter((entry) => pulses?.has(entry.camera.properties.camera_code))
          .map((entry) => {
            const generation = pulses?.get(entry.camera.properties.camera_code) ?? 0;
            return (
              <CircleMarker
                key={`pulse-${entry.camera.properties.camera_code}-${generation}`}
                center={toLatLng(entry.camera.geometry.coordinates)}
                radius={entry.radius}
                interactive={false}
                pathOptions={{
                  className: 'cam-pulse',
                  color: '#38bdf8',
                  fillOpacity: 0,
                  weight: 2,
                }}
              />
            );
          })}
      </Pane>

      <Pane name={MAP_PANES.cameras.name} style={{ zIndex: MAP_PANES.cameras.zIndex }}>
        {rendered.map((entry) => {
          const props = entry.camera.properties;
          return (
            // Fragment, not a wrapper element: `Pane` renders its children into
            // the Leaflet pane, and a stray div there serves no purpose.
            <Fragment key={props.camera_id}>
              {entry.heading ? (
                <Polyline
                  positions={entry.heading}
                  interactive={false}
                  pathOptions={{
                    color: entry.color,
                    weight: 2,
                    opacity: entry.offline ? 0.25 : 0.55,
                    dashArray: '3 3',
                  }}
                />
              ) : null}

              <CircleMarker
                center={toLatLng(entry.camera.geometry.coordinates)}
                radius={entry.radius}
                pathOptions={{
                  color: entry.selected || entry.emphasised ? '#ffffff' : entry.color,
                  weight: entry.selected ? 3 : entry.emphasised ? 2.5 : 1.5,
                  fillColor: entry.color,
                  // A faulty camera is drawn hollow: unmistakably present on the
                  // map, unmistakably not contributing data.
                  fillOpacity: entry.offline ? 0.12 : 0.75,
                  dashArray: entry.offline ? '3 3' : undefined,
                }}
                eventHandlers={
                  onSelectCamera ? { click: () => onSelectCamera(entry.camera) } : undefined
                }
              >
                {labelsVisible ? (
                  <Tooltip
                    permanent
                    direction="top"
                    offset={[0, -entry.radius - 2]}
                    className="map-label"
                  >
                    {props.camera_code}
                  </Tooltip>
                ) : null}

                <Popup>
                  <CameraPopup
                    camera={entry.camera}
                    metric={entry.metric}
                    {...(onShowTrend ? { onShowTrend } : {})}
                  />
                </Popup>
              </CircleMarker>
            </Fragment>
          );
        })}
      </Pane>
    </>
  );
}

function CameraPopup({
  camera,
  metric,
  onShowTrend,
}: {
  camera: Feature<PointGeometry, CameraProperties>;
  metric: NodeMetric | null;
  onShowTrend?: (cameraCode: string) => void;
}) {
  const props = camera.properties;

  const rows = [
    { key: 'Status', value: <Badge tone={CAMERA_STATUS_TONE[props.status]}>{props.status}</Badge> },
    {
      key: 'Last seen',
      value: (
        <span className="u-num">
          {props.last_seen_at ? formatRelative(props.last_seen_at) : 'never'}
        </span>
      ),
    },
    { key: 'Facing', value: <span className="u-num">{formatHeading(props.heading_degrees)}</span> },
    {
      key: 'Location',
      value: <span className="u-num">{formatCoords(camera.geometry.coordinates)}</span>,
    },
  ];

  if (props.road_names && props.road_names.length > 0) {
    rows.push({ key: 'Roads', value: <span>{props.road_names.join(', ')}</span> });
  }

  if (metric) {
    rows.push(
      {
        key: 'Vehicles',
        value: <span className="u-num">{formatCount(metric.vehicle_count)}</span>,
      },
      {
        key: 'Unique plates',
        value: <span className="u-num">{formatCount(metric.unique_plate_count)}</span>,
      },
      {
        key: 'Peak 5-min',
        value: <span className="u-num">{formatCount(metric.peak_5m_vehicle_count)}</span>,
      },
      {
        key: 'vs baseline',
        value: (
          <span
            className="u-num"
            style={{
              color:
                metric.vs_baseline_pct === null
                  ? undefined
                  : metric.vs_baseline_pct > 10
                    ? 'var(--c-danger)'
                    : metric.vs_baseline_pct < -10
                      ? 'var(--c-ok)'
                      : undefined,
            }}
          >
            {formatPercentDelta(metric.vs_baseline_pct)}
          </span>
        ),
      },
    );
  }

  return (
    <div>
      <div className="cam-popup__head">
        <span className="cam-popup__code">{props.camera_code}</span>
        {props.status === 'fault' ? <Badge tone="danger">no data</Badge> : null}
      </div>
      <p className="cam-popup__name">{props.display_name}</p>
      <KeyValue className="cam-popup__kv" rows={rows} />
      {props.status === 'fault' ? (
        <p className="ui-field__hint" style={{ marginBottom: 'var(--sp-2)' }}>
          This camera is faulty. Links through it report no travel time rather than
          an interpolated one.
        </p>
      ) : null}
      {onShowTrend ? (
        <div className="cam-popup__actions">
          <Button size="xs" onClick={() => onShowTrend(props.camera_code)}>
            Flow trend
          </Button>
        </div>
      ) : null}
    </div>
  );
}
