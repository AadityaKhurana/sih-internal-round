import { useEffect, useRef } from 'react';

import {
  HOP_STATUS_LABEL,
  HOP_STATUS_TONE,
  VALIDATION_LABEL,
  VALIDATION_TONE,
  formatConfidence,
} from '@/lib/congestion';
import { formatDistance, formatHeading, formatSpeed } from '@/lib/geo';
import { cx } from '@/lib/cx';
import { formatDuration, formatTime } from '@/lib/time';
import { Badge } from '@/components/ui';
import type { TrajectoryHop } from '@/types/api';
import type { Sighting } from '@/types/domain';

export interface TrajectoryTimelineProps {
  sightings: Sighting[];
  hops: TrajectoryHop[];
  /** Index reached by playback; earlier stops render as visited. */
  reachedIndex: number;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
}

/**
 * The chronological read of a trip: camera passes interleaved with the hops
 * between them.
 *
 * The hop rows carry the facts that make a route interpretable — travel time
 * against the corridor's free-flow time, distance, implied speed and direction —
 * because "the vehicle went from CAM-01 to CAM-02" is not evidence of anything on
 * its own. Where a hop is unmonitored or infeasible, the row says so in place of
 * those numbers rather than leaving a blank.
 */
export function TrajectoryTimeline({
  sightings,
  hops,
  reachedIndex,
  selectedIndex,
  onSelect,
}: TrajectoryTimelineProps) {
  const hopByFrom = new Map(hops.map((hop) => [hop.from_sighting_id, hop]));
  const activeRef = useRef<HTMLButtonElement>(null);

  // Follow playback, but only scroll within the list so the page does not jump.
  // Guarded: auto-scroll is a convenience, and it must never be the reason the
  // timeline fails to render somewhere `scrollIntoView` is unavailable.
  useEffect(() => {
    const node = activeRef.current;
    if (typeof node?.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [reachedIndex]);

  return (
    <ol className="timeline">
      {sightings.map((sighting, index) => {
        const hop = hopByFrom.get(sighting.sighting_id);
        const reached = index <= reachedIndex;

        return (
          <li key={sighting.sighting_id}>
            <button
              type="button"
              ref={index === reachedIndex ? activeRef : undefined}
              className={cx(
                'timeline__stop',
                reached && 'is-reached',
                selectedIndex === index && 'is-selected',
              )}
              onClick={() => onSelect(index)}
              aria-current={index === reachedIndex ? 'step' : undefined}
            >
              <span className="timeline__index" aria-hidden="true">
                {index + 1}
              </span>
              <span className="timeline__stop-main">
                <span className="timeline__stop-top">
                  <time className="timeline__time" dateTime={sighting.spotted_at}>
                    {formatTime(sighting.spotted_at)}
                  </time>
                  <span className="timeline__camera">{sighting.camera_code}</span>
                  {sighting.validation_status !== 'accepted' ? (
                    <Badge tone={VALIDATION_TONE[sighting.validation_status]}>
                      {VALIDATION_LABEL[sighting.validation_status]}
                    </Badge>
                  ) : null}
                </span>
                <span className="timeline__place u-truncate">
                  {sighting.camera_display_name}
                </span>
                <span className="timeline__stop-meta">
                  <span>{formatHeading(sighting.direction_degrees)}</span>
                  <span>OCR {formatConfidence(sighting.ocr_confidence)}</span>
                  {sighting.lane_number !== null ? (
                    <span>lane {sighting.lane_number}</span>
                  ) : null}
                  {sighting.vehicle_type ? <span>{sighting.vehicle_type}</span> : null}
                  {sighting.vehicle_color ? <span>{sighting.vehicle_color}</span> : null}
                </span>
              </span>
            </button>

            {hop ? <HopRow hop={hop} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function HopRow({ hop }: { hop: TrajectoryHop }) {
  const anomalous =
    hop.hop_status === 'impossible_travel_time' || hop.hop_status === 'wrong_direction';

  // Ratio against free flow is the number that says whether a transit is normal.
  const ratio =
    hop.free_flow_time_seconds && hop.free_flow_time_seconds > 0
      ? hop.travel_time_seconds / hop.free_flow_time_seconds
      : null;

  return (
    <div className="timeline__hop">
      <div className="timeline__hop-rail" aria-hidden="true">
        <span
          className={cx(
            'timeline__hop-line',
            hop.hop_status === 'no_link' && 'timeline__hop-line--dashed',
          )}
          style={
            anomalous
              ? { background: 'var(--c-danger)' }
              : hop.hop_status === 'valid'
                ? { background: 'var(--c-map-route)' }
                : undefined
          }
        />
      </div>
      <div className="timeline__hop-body">
        <span className="timeline__hop-facts">
          <span className="u-num">{formatDuration(hop.travel_time_seconds)}</span>
          {hop.distance_meters !== null ? (
            <span className="u-num">{formatDistance(hop.distance_meters)}</span>
          ) : null}
          {hop.implied_speed_kph !== null ? (
            <span className="u-num">{formatSpeed(hop.implied_speed_kph)}</span>
          ) : null}
          {hop.direction_label ? <span>{hop.direction_label}</span> : null}
          {hop.hop_status !== 'valid' ? (
            <Badge tone={HOP_STATUS_TONE[hop.hop_status]}>
              {HOP_STATUS_LABEL[hop.hop_status]}
            </Badge>
          ) : null}
        </span>

        {hop.road_name ? <span className="u-dim">{hop.road_name}</span> : null}

        {hop.hop_status === 'no_link' ? (
          <span className="u-dim">
            No monitored link between these cameras — the route taken in between was
            not observed.
          </span>
        ) : null}

        {hop.hop_status === 'impossible_travel_time' ? (
          <span className="timeline__hop-warning">
            Faster than physically possible for this link (free flow{' '}
            {formatDuration(hop.free_flow_time_seconds)}).
          </span>
        ) : null}

        {hop.hop_status === 'wrong_direction' ? (
          <span className="timeline__hop-warning">
            Recorded heading opposes the {hop.direction_label ?? 'carriageway'}.
          </span>
        ) : null}

        {hop.hop_status === 'valid' && ratio !== null ? (
          <span className="u-dim">
            {ratio < 1.15
              ? 'At free-flow pace'
              : `${ratio.toFixed(1)}× the free-flow time for this link`}
          </span>
        ) : null}
      </div>
    </div>
  );
}
