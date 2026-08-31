import { useCallback, useMemo, useState } from 'react';
import { AttributionControl, MapContainer, ScaleControl, TileLayer, ZoomControl } from 'react-leaflet';
import type { ReactNode } from 'react';

import { BASEMAP, MAP_DEFAULTS } from '@/api/config';
import { SimulatedNetworkNotice } from '@/components/SimulatedNetworkNotice';
import type { CameraLinkProperties, CameraProperties, LinkCongestion, NodeMetric } from '@/types/domain';
import type { Feature, LatLngBoundsTuple, LatLngTuple, LineStringGeometry, PointGeometry } from '@/types/geo';
import { CameraLayer, type CameraColorMode } from './CameraLayer';
import { FitBounds, FlyTo, InvalidateOnResize, ZoomWatcher } from './MapBehaviours';
import { LinkLayer, type LinkColorMode } from './LinkLayer';
import './map.css';

export interface NetworkMapProps {
  cameras: Feature<PointGeometry, CameraProperties>[];
  links: Feature<LineStringGeometry, CameraLinkProperties>[];

  congestionById?: Map<string, LinkCongestion>;
  nodeMetricsById?: Map<string, NodeMetric>;
  maxVehicleCount?: number;

  linkColorMode?: LinkColorMode;
  cameraColorMode?: CameraColorMode;
  showDirectionArrows?: boolean;
  showHeadings?: boolean;
  showLabels?: boolean;
  /** Draw the base network faintly so an overlaid route reads clearly. */
  dimNetwork?: boolean;

  selectedCameraId?: string | null;
  selectedLinkId?: string | null;
  /** Camera code → pulse generation, for the live-sighting halo. */
  pulses?: ReadonlyMap<string, number>;
  emphasisedCameraCodes?: ReadonlySet<string>;

  onSelectCamera?: (camera: Feature<PointGeometry, CameraProperties>) => void;
  onSelectLink?: (link: Feature<LineStringGeometry, CameraLinkProperties>) => void;
  onShowTrend?: (cameraCode: string) => void;

  fitBounds?: LatLngBoundsTuple | null;
  flyTo?: LatLngTuple | null;

  /** Extra map layers, e.g. a trajectory route. Rendered above the network. */
  children?: ReactNode;

  overlayTopLeft?: ReactNode;
  overlayTopRight?: ReactNode;
  overlayBottomLeft?: ReactNode;
  overlayBottomRight?: ReactNode;
}

/**
 * The shared map canvas.
 *
 * Owns the Leaflet container, the basemap, the camera and link layers, and the
 * floating overlay slots. Every screen that shows geography composes this rather
 * than instantiating its own map, so the network is drawn identically on the
 * operations map, the trajectory replay and the congestion overlay.
 *
 * The "simulated demo network" notice is rendered by this component, not by the
 * pages — that way no future screen can show camera geography without it.
 */
export function NetworkMap({
  cameras,
  links,
  congestionById,
  nodeMetricsById,
  maxVehicleCount = 0,
  linkColorMode = 'network',
  cameraColorMode = 'status',
  showDirectionArrows = true,
  showHeadings = true,
  showLabels = true,
  dimNetwork = false,
  selectedCameraId = null,
  selectedLinkId = null,
  pulses,
  emphasisedCameraCodes,
  onSelectCamera,
  onSelectLink,
  onShowTrend,
  fitBounds = null,
  flyTo = null,
  children,
  overlayTopLeft,
  overlayTopRight,
  overlayBottomLeft,
  overlayBottomRight,
}: NetworkMapProps) {
  const [zoom, setZoom] = useState(MAP_DEFAULTS.zoom);
  const handleZoom = useCallback((next: number) => setZoom(next), []);

  const visibleLinks = useMemo(
    () => links.filter((link) => link.properties.active),
    [links],
  );

  return (
    <div className="map-shell">
      <div className="map-shell__canvas">
        <MapContainer
          center={MAP_DEFAULTS.center}
          zoom={MAP_DEFAULTS.zoom}
          minZoom={MAP_DEFAULTS.minZoom}
          maxZoom={MAP_DEFAULTS.maxZoom}
          zoomControl={false}
          attributionControl={false}
          preferCanvas={false}
        >
          <TileLayer
            url={BASEMAP.url}
            subdomains={BASEMAP.subdomains}
            maxZoom={MAP_DEFAULTS.maxZoom}
            // Basemap attribution is a licence condition, not decoration.
            attribution={BASEMAP.attribution}
          />

          <ZoomControl position="bottomright" />
          <ScaleControl position="bottomleft" imperial={false} />
          <AttributionControl position="bottomright" prefix={false} />

          <InvalidateOnResize />
          <ZoomWatcher onZoom={handleZoom} />
          <FitBounds bounds={fitBounds} />
          <FlyTo target={flyTo} />

          <LinkLayer
            links={visibleLinks}
            {...(congestionById ? { congestionById } : {})}
            colorMode={linkColorMode}
            selectedLinkId={selectedLinkId}
            highlightCameraId={selectedCameraId}
            showDirectionArrows={showDirectionArrows}
            dim={dimNetwork}
            zoom={zoom}
            {...(onSelectLink ? { onSelectLink } : {})}
          />

          <CameraLayer
            cameras={cameras}
            {...(nodeMetricsById ? { metricsById: nodeMetricsById } : {})}
            maxVehicleCount={maxVehicleCount}
            colorMode={cameraColorMode}
            selectedCameraId={selectedCameraId}
            {...(pulses ? { pulses } : {})}
            {...(emphasisedCameraCodes ? { emphasisedCameraCodes } : {})}
            showHeadings={showHeadings}
            showLabels={showLabels}
            zoom={zoom}
            {...(onSelectCamera ? { onSelectCamera } : {})}
            {...(onShowTrend ? { onShowTrend } : {})}
          />

          {children}
        </MapContainer>
      </div>

      {overlayTopLeft ? (
        <div className="map-overlay map-overlay--top-left">{overlayTopLeft}</div>
      ) : null}

      <div className="map-overlay map-overlay--top-right">
        <SimulatedNetworkNotice variant="inline" />
        {overlayTopRight}
      </div>

      {overlayBottomLeft ? (
        <div className="map-overlay map-overlay--bottom-left">{overlayBottomLeft}</div>
      ) : null}

      {overlayBottomRight ? (
        <div className="map-overlay map-overlay--bottom-right">{overlayBottomRight}</div>
      ) : null}
    </div>
  );
}
