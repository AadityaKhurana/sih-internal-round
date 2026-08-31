import { useMemo } from 'react';

import {
  PauseIcon,
  PlayIcon,
  SkipEndIcon,
  SkipStartIcon,
  StepBackIcon,
  StepForwardIcon,
} from '@/components/icons';
import { Button, SegmentedControl } from '@/components/ui';
import { cx } from '@/lib/cx';
import { formatDuration, formatTime } from '@/lib/time';
import type { TrajectoryHop } from '@/types/api';
import type { Sighting } from '@/types/domain';
import { PLAYBACK_SPEEDS, type PlaybackClock, type PlaybackSpeed } from './playback';

const SPEED_OPTIONS = PLAYBACK_SPEEDS.map((speed) => ({
  value: String(speed) as `${PlaybackSpeed}`,
  label: `${speed}×`,
  title: `${speed}× real time`,
}));

export interface PlaybackControlsProps {
  clock: PlaybackClock;
  sightings: Sighting[];
  hops: TrajectoryHop[];
  startMs: number;
  endMs: number;
}

/**
 * Transport controls for the route replay.
 *
 * The scrubber is a real `<input type="range">` so it is keyboard- and
 * screen-reader-operable for free. Camera passes are marked as ticks beneath it,
 * anomalous hops in red, so an operator can jump straight to the interesting
 * moment instead of hunting for it.
 */
export function PlaybackControls({
  clock,
  sightings,
  hops,
  startMs,
  endMs,
}: PlaybackControlsProps) {
  const span = Math.max(1, endMs - startMs);

  const ticks = useMemo(() => {
    const anomalousFrom = new Set(
      hops
        .filter(
          (hop) =>
            hop.hop_status === 'impossible_travel_time' ||
            hop.hop_status === 'wrong_direction',
        )
        .map((hop) => hop.from_sighting_id),
    );

    return sightings.map((sighting) => ({
      id: sighting.sighting_id,
      pct: ((Date.parse(sighting.spotted_at) - startMs) / span) * 100,
      anomalous: anomalousFrom.has(sighting.sighting_id),
      label: `${sighting.camera_code} at ${formatTime(sighting.spotted_at)}`,
    }));
  }, [sightings, hops, startMs, span]);

  /** Jump to the previous/next camera pass rather than a fixed time step. */
  const stepToStop = (direction: -1 | 1) => {
    const times = sightings.map((sighting) => Date.parse(sighting.spotted_at));
    if (direction === 1) {
      const next = times.find((time) => time > clock.virtualMs + 250);
      clock.seekTo(next ?? endMs);
    } else {
      const previous = [...times].reverse().find((time) => time < clock.virtualMs - 250);
      clock.seekTo(previous ?? startMs);
    }
  };

  const elapsed = Math.round((clock.virtualMs - startMs) / 1000);

  return (
    <div className="playback">
      <div className="playback__row">
        <Button
          size="sm"
          iconOnly
          aria-label="Jump to the start"
          onClick={() => clock.seekTo(startMs)}
        >
          <SkipStartIcon size={14} />
        </Button>
        <Button
          size="sm"
          iconOnly
          aria-label="Previous camera pass"
          onClick={() => stepToStop(-1)}
        >
          <StepBackIcon size={14} />
        </Button>
        <Button
          size="sm"
          variant="primary"
          iconOnly
          aria-label={clock.playing ? 'Pause replay' : 'Play replay'}
          onClick={clock.toggle}
        >
          {clock.playing ? <PauseIcon size={13} /> : <PlayIcon size={13} />}
        </Button>
        <Button
          size="sm"
          iconOnly
          aria-label="Next camera pass"
          onClick={() => stepToStop(1)}
        >
          <StepForwardIcon size={14} />
        </Button>
        <Button
          size="sm"
          iconOnly
          aria-label="Jump to the end"
          onClick={() => clock.seekTo(endMs)}
        >
          <SkipEndIcon size={14} />
        </Button>

        <span className="playback__clock" aria-live="off">
          {formatTime(clock.virtualMs)}
        </span>

        <span className="u-dim" style={{ fontSize: 'var(--fs-2xs)' }}>
          +{formatDuration(elapsed)}
        </span>

        <span className="u-grow" />

        <SegmentedControl
          ariaLabel="Playback speed"
          value={String(clock.speed) as `${PlaybackSpeed}`}
          options={SPEED_OPTIONS}
          onChange={(next) => clock.setSpeed(Number(next) as PlaybackSpeed)}
        />
      </div>

      <div className="playback__row">
        <div className="playback__scrub-wrap">
          <input
            className="ui-range"
            type="range"
            min={0}
            max={1000}
            step={1}
            value={Math.round(clock.progress * 1000)}
            onChange={(event) => clock.seekFraction(Number(event.target.value) / 1000)}
            aria-label="Replay position"
            aria-valuetext={`${formatTime(clock.virtualMs)}, ${formatDuration(elapsed)} into the trip`}
          />
          <div className="playback__ticks" aria-hidden="true">
            {ticks.map((tick) => (
              <span
                key={tick.id}
                className={cx('playback__tick', tick.anomalous && 'playback__tick--anomaly')}
                style={{ left: `${Math.max(0, Math.min(100, tick.pct))}%` }}
                title={tick.label}
              />
            ))}
          </div>
        </div>
        <span className="u-dim" style={{ fontSize: 'var(--fs-2xs)', whiteSpace: 'nowrap' }}>
          {formatTime(startMs)} → {formatTime(endMs)}
        </span>
      </div>
    </div>
  );
}
