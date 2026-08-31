/**
 * Playback model for a reconstructed trajectory.
 *
 * Playback runs over one **segment** (one trip), not the whole history. A plate
 * seen over four days has many trips separated by hours of parking; scrubbing
 * across those gaps would spend most of the timeline showing a stationary marker.
 * The page picks a segment and this module plays it.
 *
 * The cursor is a virtual timestamp, not a frame index, so the marker moves at a
 * rate proportional to real travel time: a slow crawl down Brigade Road visibly
 * takes longer than the same distance on Airport Road.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { bearingDegrees, pointAlongLine } from '@/lib/geo';
import type { TrajectoryHop, TrajectorySegment } from '@/types/api';
import type { Sighting } from '@/types/domain';
import type { Position } from '@/types/geo';

export const PLAYBACK_SPEEDS = [1, 4, 15, 60, 240] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export interface PlaybackClock {
  /** Current virtual instant, epoch ms. */
  virtualMs: number;
  playing: boolean;
  speed: PlaybackSpeed;
  /** 0–1 through the segment. */
  progress: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seekTo: (ms: number) => void;
  seekFraction: (fraction: number) => void;
  setSpeed: (speed: PlaybackSpeed) => void;
  restart: () => void;
  atEnd: boolean;
}

/**
 * Drives the virtual clock with `requestAnimationFrame`.
 *
 * The clock is held in a ref as well as state: the animation callback needs the
 * previous value without re-subscribing every frame, and reading it from state
 * inside the loop would capture a stale value.
 */
export function usePlaybackClock(startMs: number, endMs: number): PlaybackClock {
  const span = Math.max(1, endMs - startMs);

  const [virtualMs, setVirtualMs] = useState(startMs);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(15);
  const clockRef = useRef(startMs);

  // A new segment resets the clock; leaving it mid-way through the previous
  // segment's time range would put the marker nowhere sensible.
  useEffect(() => {
    clockRef.current = startMs;
    setVirtualMs(startMs);
    setPlaying(false);
  }, [startMs, endMs]);

  useEffect(() => {
    if (!playing) return;

    let frame = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const delta = now - last;
      last = now;

      const next = clockRef.current + delta * speed;
      if (next >= endMs) {
        clockRef.current = endMs;
        setVirtualMs(endMs);
        setPlaying(false);
        return;
      }

      clockRef.current = next;
      setVirtualMs(next);
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, endMs]);

  const seekTo = useCallback(
    (ms: number) => {
      const clamped = Math.max(startMs, Math.min(endMs, ms));
      clockRef.current = clamped;
      setVirtualMs(clamped);
    },
    [startMs, endMs],
  );

  const seekFraction = useCallback(
    (fraction: number) => seekTo(startMs + span * Math.max(0, Math.min(1, fraction))),
    [seekTo, startMs, span],
  );

  const restart = useCallback(() => {
    seekTo(startMs);
    setPlaying(true);
  }, [seekTo, startMs]);

  const atEnd = virtualMs >= endMs;

  return {
    virtualMs,
    playing,
    speed,
    progress: (virtualMs - startMs) / span,
    play: useCallback(() => setPlaying(true), []),
    pause: useCallback(() => setPlaying(false), []),
    // Replaying from the end is the common case after a run finishes.
    toggle: useCallback(() => {
      if (atEnd) {
        seekTo(startMs);
        setPlaying(true);
        return;
      }
      setPlaying((current) => !current);
    }, [atEnd, seekTo, startMs]),
    seekTo,
    seekFraction,
    setSpeed,
    restart,
    atEnd,
  };
}

/* ------------------------------------------------------------------ geometry -- */

/** Path a hop follows: the real link geometry, or a straight line if unmonitored. */
export function hopPath(hop: TrajectoryHop, from: Position, to: Position): Position[] {
  return hop.path ? hop.path.coordinates : [from, to];
}

export interface PlaybackPosition {
  /** Where the vehicle marker sits right now. */
  position: Position;
  bearing: number;
  /** Index into the segment's sightings that has been reached. */
  reachedIndex: number;
  /** The hop currently being traversed, if between two sightings. */
  activeHop: TrajectoryHop | null;
  /** 0–1 through the active hop. */
  hopFraction: number;
  /** True while the vehicle is sitting at a camera rather than between two. */
  atCamera: boolean;
}

/**
 * Resolve the marker position for a virtual instant.
 *
 * Interpolates along the link's real geometry rather than between camera points,
 * so the marker follows the road. For an unmonitored hop it walks a straight line
 * — and the layer draws that dashed, because the route there is inferred, not
 * observed.
 */
export function resolvePlaybackPosition(
  sightings: Sighting[],
  hops: TrajectoryHop[],
  virtualMs: number,
): PlaybackPosition | null {
  const first = sightings[0];
  if (!first) return null;

  const firstMs = Date.parse(first.spotted_at);
  if (virtualMs <= firstMs) {
    return {
      position: first.camera_location,
      bearing: first.direction_degrees ?? 0,
      reachedIndex: 0,
      activeHop: null,
      hopFraction: 0,
      atCamera: true,
    };
  }

  const hopById = new Map(hops.map((hop) => [hop.from_sighting_id, hop]));

  for (let i = 0; i < sightings.length - 1; i += 1) {
    const current = sightings[i]!;
    const next = sightings[i + 1]!;
    const startMs = Date.parse(current.spotted_at);
    const endMs = Date.parse(next.spotted_at);

    if (virtualMs >= startMs && virtualMs < endMs) {
      const hop = hopById.get(current.sighting_id) ?? null;
      const fraction = endMs === startMs ? 0 : (virtualMs - startMs) / (endMs - startMs);

      const path = hop
        ? hopPath(hop, current.camera_location, next.camera_location)
        : [current.camera_location, next.camera_location];

      const point = pointAlongLine(path, fraction);
      return {
        position: point?.position ?? current.camera_location,
        bearing:
          point?.bearing ??
          bearingDegrees(current.camera_location, next.camera_location),
        reachedIndex: i,
        activeHop: hop,
        hopFraction: fraction,
        atCamera: false,
      };
    }
  }

  const last = sightings[sightings.length - 1]!;
  return {
    position: last.camera_location,
    bearing: last.direction_degrees ?? 0,
    reachedIndex: sightings.length - 1,
    activeHop: null,
    hopFraction: 1,
    atCamera: true,
  };
}

/** Sightings and hops belonging to one segment, in order. */
export function sliceSegment(
  segment: TrajectorySegment,
  allSightings: Sighting[],
  allHops: TrajectoryHop[],
): { sightings: Sighting[]; hops: TrajectoryHop[] } {
  const ids = new Set(segment.sighting_ids);
  const sightings = allSightings.filter((s) => ids.has(s.sighting_id));
  const hops = allHops.filter(
    (hop) => ids.has(hop.from_sighting_id) && ids.has(hop.to_sighting_id),
  );
  return { sightings, hops };
}
