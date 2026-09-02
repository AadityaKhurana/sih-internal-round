import { useMemo } from 'react';
import { Pane, Polyline, Tooltip } from 'react-leaflet';

import {
  CONGESTION_LABELS,
  congestionColorHex,
  congestionLevel,
  isLowSample,
} from '@/lib/congestion';
import { chevronAlongLine, formatDistance, formatSpeed, offsetLine, toLatLngs } from '@/lib/geo';
import { formatDuration } from '@/lib/time';
import type { CameraLinkProperties, LinkCongestion } from '@/types/domain';
import type { Feature, LineStringGeometry, Position } from '@/types/geo';
import { MAP_PANES } from './panes';

export type LinkColorMode = 'network' | 'congestion';

export interface LinkLayerProps {
  links: Feature<LineStringGeometry, CameraLinkProperties>[];
  /** Congestion metrics keyed by `camera_link_id`; required for congestion mode. */
  congestionById?: Map<string, LinkCongestion>;
  colorMode?: LinkColorMode;
  selectedLinkId?: string | null;
  /** Highlight every link touching this camera. */
  highlightCameraId?: string | null;
  onSelectLink?: (link: Feature<LineStringGeometry, CameraLinkProperties>) => void;
  showDirectionArrows?: boolean;
  /**
   * Fade the whole network. Applied to each path's own opacity rather than to a
   * wrapping element, because `Pane` portals its children out of the React tree
   * and a parent's CSS opacity would never reach them.
   */
  dim?: boolean;
  /** Current map zoom, used to scale decoration so it stays legible. */
  zoom: number;
}

/**
 * The directed `camera_links` network.
 *
 * Two things worth knowing:
 *
 *  1. Each corridor exists twice in the schema (A→B and B→A) with mirrored
 *     geometry. Drawn as-is, one direction sits exactly on top of the other and
 *     becomes invisible — so each direction is nudged onto its own side of the
 *     road and given a direction chevron. A congestion overlay that silently
 *     showed only one carriageway would be actively misleading.
 *
 *  2. A link with no matched journeys gets the explicit "no data" colour rather
 *     than being coloured as free-flowing. Absence of measurement is not absence
 *     of congestion.
 */
export function LinkLayer({
  links,
  congestionById,
  colorMode = 'network',
  selectedLinkId = null,
  highlightCameraId = null,
  onSelectLink,
  showDirectionArrows = true,
  dim = false,
  zoom,
}: LinkLayerProps) {
  // Decoration scales with zoom so arrows stay readable without swamping the map.
  const arrowMeters = useMemo(() => Math.max(12, 2 ** (17 - zoom) * 14), [zoom]);
  const offsetMeters = useMemo(() => Math.max(4, 2 ** (17 - zoom) * 5), [zoom]);

  const rendered = useMemo(
    () =>
      links.map((link) => {
        const props = link.properties;
        const congestion = congestionById?.get(props.camera_link_id) ?? null;
        const level = congestionLevel(congestion?.congestion_score ?? null);

        const offset: Position[] = offsetLine(link.geometry.coordinates, offsetMeters);
        const positions = toLatLngs(offset);
        const chevron = showDirectionArrows
          ? chevronAlongLine(offset, 0.55, arrowMeters)
          : null;

        const isSelected = selectedLinkId === props.camera_link_id;
        const touchesCamera =
          highlightCameraId !== null &&
          (props.from_camera_id === highlightCameraId ||
            props.to_camera_id === highlightCameraId);

        let color: string;
        let weight: number;
        let opacity: number;

        if (colorMode === 'congestion') {
          color = congestionColorHex(level);
          weight = level === 'unknown' ? 2.5 : 4;
          opacity = level === 'unknown' ? 0.5 : 0.85;
        } else {
          color = touchesCamera ? 'var(--c-map-link-active)' : '#64748b';
          weight = touchesCamera ? 3.5 : 2;
          opacity = touchesCamera ? 0.9 : 0.5;
        }

        if (isSelected) {
          weight += 2.5;
          opacity = 1;
        }
        if (highlightCameraId !== null && !touchesCamera && colorMode === 'network') {
          opacity = 0.18;
        }
        if (dim) {
          opacity *= 0.45;
        }

        return {
          link,
          positions,
          chevron: chevron ? toLatLngs(chevron) : null,
          color,
          weight,
          opacity,
          isSelected,
          congestion,
          level,
        };
      }),
    [
      links,
      congestionById,
      colorMode,
      selectedLinkId,
      highlightCameraId,
      showDirectionArrows,
      dim,
      arrowMeters,
      offsetMeters,
    ],
  );

  return (
    <>
      <Pane name={MAP_PANES.links.name} style={{ zIndex: MAP_PANES.links.zIndex }}>
        {rendered
          .filter((entry) => !entry.isSelected)
          .map((entry) => (
            <LinkPolyline key={entry.link.properties.camera_link_id} entry={entry} onSelectLink={onSelectLink} />
          ))}
      </Pane>

      {/* Selected links move to their own pane so a highlight can never be
          obscured by a neighbouring carriageway drawn later. */}
      <Pane name={MAP_PANES.linksTop.name} style={{ zIndex: MAP_PANES.linksTop.zIndex }}>
        {rendered
          .filter((entry) => entry.isSelected)
          .map((entry) => (
            <LinkPolyline key={entry.link.properties.camera_link_id} entry={entry} onSelectLink={onSelectLink} />
          ))}
      </Pane>
    </>
  );
}

type RenderedLink = {
  link: Feature<LineStringGeometry, CameraLinkProperties>;
  positions: [number, number][];
  chevron: [number, number][] | null;
  color: string;
  weight: number;
  opacity: number;
  isSelected: boolean;
  congestion: LinkCongestion | null;
  level: ReturnType<typeof congestionLevel>;
};

function LinkPolyline({
  entry,
  onSelectLink,
}: {
  entry: RenderedLink;
  onSelectLink?: (link: Feature<LineStringGeometry, CameraLinkProperties>) => void;
}) {
  const props = entry.link.properties;
  const { congestion } = entry;

  return (
    <>
      {/* Invisible wide stroke purely for hit-testing: a 2 px line is close to
          impossible to hover or click, especially on a touch screen. */}
      <Polyline
        positions={entry.positions}
        pathOptions={{ color: entry.color, weight: 14, opacity: 0 }}
        bubblingMouseEvents={false}
        eventHandlers={
          onSelectLink ? { click: () => onSelectLink(entry.link) } : undefined
        }
      >
        <Tooltip sticky>
          <strong className="u-num">
            {props.from_camera_code} → {props.to_camera_code}
          </strong>
          {props.direction_label ? ` · ${props.direction_label}` : ''}
          <br />
          {props.road_name ?? 'Unnamed corridor'}
          <br />
          <span className="u-dim">
            {formatDistance(props.distance_meters)} · free flow{' '}
            {formatDuration(props.free_flow_time_seconds)}
          </span>
          {congestion ? (
            <>
              <br />
              <span style={{ color: congestionColorHex(entry.level) }}>
                {CONGESTION_LABELS[entry.level]}
                {congestion.congestion_score !== null
                  ? ` · ${congestion.congestion_score.toFixed(2)}× free flow`
                  : ''}
              </span>
              <br />
              <span className="u-dim">
                {congestion.median_travel_time_seconds !== null
                  ? `median ${formatDuration(congestion.median_travel_time_seconds)} · ${formatSpeed(congestion.derived_speed_kph)}`
                  : 'no matched journeys'}
              </span>
              <br />
              <span className="u-dim">
                {congestion.vehicle_count.toLocaleString()} vehicles ·{' '}
                {congestion.travel_time_sample_count} matched
                {isLowSample(congestion.travel_time_sample_count)
                  ? ' (low confidence)'
                  : ''}
              </span>
            </>
          ) : null}
        </Tooltip>
      </Polyline>

      <Polyline
        positions={entry.positions}
        interactive={false}
        pathOptions={{
          color: entry.color,
          weight: entry.weight,
          opacity: entry.opacity,
          lineCap: 'round',
        }}
      />

      {entry.chevron ? (
        <Polyline
          positions={entry.chevron}
          interactive={false}
          pathOptions={{
            color: entry.color,
            weight: Math.max(1.5, entry.weight - 1),
            opacity: Math.min(1, entry.opacity + 0.15),
            lineCap: 'round',
            lineJoin: 'round',
            fill: false,
          }}
        />
      ) : null}
    </>
  );
}
