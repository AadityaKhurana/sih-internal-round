import { Fragment, useMemo } from 'react';
import { CircleMarker, Pane, Polyline, Tooltip } from 'react-leaflet';

import { HOP_STATUS_HEX, HOP_STATUS_LABEL, VALIDATION_LABEL } from '@/lib/congestion';
import {
  chevronAlongLine,
  formatDistance,
  formatSpeed,
  lineMidpoint,
  sliceLine,
  toLatLng,
  toLatLngs,
} from '@/lib/geo';
import { formatDuration, formatTime } from '@/lib/time';
import { useZoomLevel } from '@/features/map/MapBehaviours';
import { MAP_PANES } from '@/features/map/panes';
import type { TrajectoryHop } from '@/types/api';
import type { Sighting, ValidationStatus } from '@/types/domain';
import type { PlaybackPosition } from './playback';
import { hopPath } from './playback';

const VALIDATION_HEX: Record<ValidationStatus, string> = {
  accepted: '#f0abfc',
  pending: '#94a3b8',
  uncertain: '#fbbf24',
  conflict: '#f87171',
};

export interface TrajectoryLayerProps {
  sightings: Sighting[];
  hops: TrajectoryHop[];
  position: PlaybackPosition | null;
  /** Index of the sighting the operator has selected in the timeline. */
  selectedIndex: number | null;
  onSelectSighting?: (index: number) => void;
}

/**
 * The route overlay.
 *
 * Three things this deliberately does *not* do:
 *
 *  - It does not draw a straight line between cameras when a monitored link
 *    exists. It follows `camera_links.path`, because the point of validating a
 *    transition against the link graph is to know which road was used.
 *  - It does not draw an unmonitored hop the same as a validated one. Those are
 *    dashed and greyed, since the route between those two cameras was never
 *    observed — only the endpoints were.
 *  - It does not hide anomalous hops. An impossible transit is drawn in red with
 *    a marker, because that is the most operationally interesting thing on screen.
 */
export function TrajectoryLayer({
  sightings,
  hops,
  position,
  selectedIndex,
  onSelectSighting,
}: TrajectoryLayerProps) {
  const zoom = useZoomLevel();
  const arrowMeters = useMemo(() => Math.max(14, 2 ** (17 - zoom) * 16), [zoom]);
  const sightingById = useMemo(
    () => new Map(sightings.map((s) => [s.sighting_id, s])),
    [sightings],
  );
  const indexById = useMemo(
    () => new Map(sightings.map((s, index) => [s.sighting_id, index])),
    [sightings],
  );

  const rendered = useMemo(
    () =>
      hops.flatMap((hop) => {
        const from = sightingById.get(hop.from_sighting_id);
        const to = sightingById.get(hop.to_sighting_id);
        if (!from || !to) return [];

        const path = hopPath(hop, from.camera_location, to.camera_location);
        const hopIndex = indexById.get(hop.from_sighting_id) ?? 0;

        // How much of this hop the playback cursor has covered.
        let travelledFraction = 0;
        if (position) {
          if (position.reachedIndex > hopIndex) travelledFraction = 1;
          else if (position.reachedIndex === hopIndex && position.activeHop === hop) {
            travelledFraction = position.hopFraction;
          }
        }

        return [
          {
            hop,
            from,
            to,
            path,
            latlngs: toLatLngs(path),
            travelled: travelledFraction > 0 ? toLatLngs(sliceLine(path, travelledFraction)) : [],
            chevron: chevronAlongLine(path, 0.6, arrowMeters),
            color: HOP_STATUS_HEX[hop.hop_status],
            dashed: hop.hop_status === 'no_link',
            anomalous:
              hop.hop_status === 'impossible_travel_time' ||
              hop.hop_status === 'wrong_direction',
            midpoint: lineMidpoint(path),
          },
        ];
      }),
    [hops, sightingById, indexById, position, arrowMeters],
  );

  return (
    <>
      <Pane name={MAP_PANES.route.name} style={{ zIndex: MAP_PANES.route.zIndex }}>
        {rendered.map((entry) => (
          <Fragment key={`${entry.hop.from_sighting_id}-${entry.hop.to_sighting_id}`}>
            {/* Full route, muted: where the vehicle will go. */}
            <Polyline
              positions={entry.latlngs}
              className="route-line"
              pathOptions={{
                color: entry.color,
                weight: entry.anomalous ? 5 : 4,
                opacity: entry.dashed ? 0.4 : 0.32,
                dashArray: entry.dashed ? '7 8' : undefined,
                lineCap: 'round',
              }}
            >
              <Tooltip sticky>
                <strong className="u-num">
                  {entry.hop.from_camera_code} → {entry.hop.to_camera_code}
                </strong>
                <br />
                <span style={{ color: entry.color }}>
                  {HOP_STATUS_LABEL[entry.hop.hop_status]}
                </span>
                <br />
                <span className="u-dim">
                  {formatTime(entry.hop.departed_at)} → {formatTime(entry.hop.arrived_at)}
                </span>
                <br />
                {formatDuration(entry.hop.travel_time_seconds)}
                {entry.hop.distance_meters !== null
                  ? ` · ${formatDistance(entry.hop.distance_meters)}`
                  : ' · distance unknown'}
                {entry.hop.implied_speed_kph !== null ? (
                  <>
                    <br />
                    {formatSpeed(entry.hop.implied_speed_kph)}
                    {entry.hop.free_flow_time_seconds !== null
                      ? ` · free flow ${formatDuration(entry.hop.free_flow_time_seconds)}`
                      : ''}
                  </>
                ) : null}
                {entry.hop.hop_status === 'no_link' ? (
                  <>
                    <br />
                    <span className="u-dim">
                      No monitored link — the road taken was not observed.
                    </span>
                  </>
                ) : null}
              </Tooltip>
            </Polyline>

            {/* Travelled portion, bright: where it has already been. */}
            {entry.travelled.length > 1 ? (
              <Polyline
                positions={entry.travelled}
                interactive={false}
                className="route-line"
                pathOptions={{
                  color: entry.color,
                  weight: entry.anomalous ? 6 : 5,
                  opacity: 0.95,
                  dashArray: entry.dashed ? '7 8' : undefined,
                  lineCap: 'round',
                }}
              />
            ) : null}

            {entry.chevron ? (
              <Polyline
                positions={toLatLngs(entry.chevron)}
                interactive={false}
                pathOptions={{
                  color: entry.color,
                  weight: 2.5,
                  opacity: 0.85,
                  fill: false,
                }}
              />
            ) : null}
          </Fragment>
        ))}
      </Pane>

      <Pane name={MAP_PANES.routeTop.name} style={{ zIndex: MAP_PANES.routeTop.zIndex }}>
        {/* Anomaly flags sit on the route so the problem is visible without
            reading the timeline. */}
        {rendered
          .filter((entry) => entry.anomalous && entry.midpoint)
          .map((entry) => (
            <CircleMarker
              key={`flag-${entry.hop.from_sighting_id}`}
              center={toLatLng(entry.midpoint!)}
              radius={7}
              pathOptions={{
                color: '#ffffff',
                weight: 2,
                fillColor: entry.color,
                fillOpacity: 1,
              }}
            >
              <Tooltip direction="top">
                <strong style={{ color: entry.color }}>
                  {HOP_STATUS_LABEL[entry.hop.hop_status]}
                </strong>
                <br />
                {entry.hop.hop_status === 'impossible_travel_time' ? (
                  <>
                    {formatDuration(entry.hop.travel_time_seconds)} across{' '}
                    {formatDistance(entry.hop.distance_meters)} ·{' '}
                    {formatSpeed(entry.hop.implied_speed_kph)}
                  </>
                ) : (
                  <>Heading contradicts {entry.hop.direction_label ?? 'the carriageway'}</>
                )}
              </Tooltip>
            </CircleMarker>
          ))}

        {/* Numbered sighting stops. */}
        {sightings.map((sighting, index) => {
          const reached = position ? index <= position.reachedIndex : false;
          const isSelected = selectedIndex === index;
          const color = VALIDATION_HEX[sighting.validation_status];

          return (
            <CircleMarker
              key={sighting.sighting_id}
              center={toLatLng(sighting.camera_location)}
              radius={isSelected ? 11 : 8}
              pathOptions={{
                color: isSelected ? '#ffffff' : color,
                weight: isSelected ? 3 : 2,
                fillColor: color,
                // Un-reached stops are hollow, so playback progress is legible
                // from the map alone.
                fillOpacity: reached ? 0.9 : 0.25,
              }}
              eventHandlers={
                onSelectSighting ? { click: () => onSelectSighting(index) } : undefined
              }
            >
              <Tooltip permanent direction="right" offset={[8, 0]} className="map-label">
                {index + 1}
              </Tooltip>
              <Tooltip direction="top" offset={[0, -10]}>
                <strong>
                  {index + 1}. {sighting.camera_code}
                </strong>{' '}
                <span className="u-dim">{sighting.camera_display_name}</span>
                <br />
                {formatTime(sighting.spotted_at)}
                <br />
                <span style={{ color }}>
                  {VALIDATION_LABEL[sighting.validation_status]}
                </span>
              </Tooltip>
            </CircleMarker>
          );
        })}

        {/* The vehicle. Drawn last so it is never hidden behind a stop. */}
        {position ? (
          <>
            <CircleMarker
              center={toLatLng(position.position)}
              radius={6}
              interactive={false}
              pathOptions={{
                color: '#ffffff',
                weight: 2,
                fillColor: '#38bdf8',
                fillOpacity: 1,
              }}
            />
            <CircleMarker
              center={toLatLng(position.position)}
              radius={13}
              interactive={false}
              pathOptions={{
                color: '#38bdf8',
                weight: 1.5,
                opacity: 0.6,
                fillOpacity: 0,
              }}
            />
          </>
        ) : null}
      </Pane>
    </>
  );
}
