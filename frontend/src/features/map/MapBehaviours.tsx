/**
 * Small `useMap`-driven behaviours. Each is a component with no output so it can
 * be dropped into the map tree declaratively rather than threading a map ref
 * through the page.
 */

import { useEffect, useRef, useState } from 'react';
import { useMap } from 'react-leaflet';
import type { LatLngBoundsExpression } from 'leaflet';

import type { LatLngBoundsTuple, LatLngTuple } from '@/types/geo';

/**
 * Fit the map to `bounds` once per distinct bounds value.
 *
 * Deliberately not re-fitting on every render: an operator who has panned or
 * zoomed should not have the view yanked back underneath them, which is what
 * happens when a fit is tied to a data refresh.
 */
export function FitBounds({
  bounds,
  padding = 48,
  maxZoom = 16,
}: {
  bounds: LatLngBoundsTuple | null;
  padding?: number;
  maxZoom?: number;
}) {
  const map = useMap();
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!bounds) return;
    const key = JSON.stringify(bounds);
    if (lastKey.current === key) return;
    lastKey.current = key;

    map.fitBounds(bounds as LatLngBoundsExpression, {
      paddingTopLeft: [padding, padding],
      paddingBottomRight: [padding, padding],
      maxZoom,
      animate: true,
    });
  }, [map, bounds, padding, maxZoom]);

  return null;
}

/** Centre on a point when `target` changes. Used by "locate this camera". */
export function FlyTo({
  target,
  zoom = 16,
}: {
  target: LatLngTuple | null;
  zoom?: number;
}) {
  const map = useMap();
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!target) return;
    const key = `${target[0]},${target[1]},${zoom}`;
    if (lastKey.current === key) return;
    lastKey.current = key;
    map.flyTo(target, zoom, { duration: 0.7 });
  }, [map, target, zoom]);

  return null;
}

/**
 * Ask Leaflet to re-measure after the container resizes.
 *
 * The map lives in a CSS grid cell that changes width when the alert dock is
 * collapsed. Leaflet caches the container size, so without this the tiles are
 * laid out for the old width and the map renders with grey bands.
 */
export function InvalidateOnResize() {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    const observer = new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [map]);

  return null;
}

/** Keep the parent informed of the current zoom, for zoom-dependent detail. */
export function ZoomWatcher({ onZoom }: { onZoom: (zoom: number) => void }) {
  const map = useMap();

  useEffect(() => {
    const report = () => onZoom(map.getZoom());
    report();
    map.on('zoomend', report);
    return () => {
      map.off('zoomend', report);
    };
  }, [map, onZoom]);

  return null;
}

/**
 * Current zoom, for layers rendered as `NetworkMap` children.
 *
 * Those layers are inside the map's React tree but outside `NetworkMap`'s own
 * state, so they read the zoom directly rather than having a value threaded down
 * to them — which is how a hardcoded placeholder ends up scaling decoration
 * wrongly at every zoom but one.
 */
export function useZoomLevel(): number {
  const map = useMap();
  const [zoom, setZoom] = useState(() => map.getZoom());

  useEffect(() => {
    const report = () => setZoom(map.getZoom());
    map.on('zoomend', report);
    return () => {
      map.off('zoomend', report);
    };
  }, [map]);

  return zoom;
}
