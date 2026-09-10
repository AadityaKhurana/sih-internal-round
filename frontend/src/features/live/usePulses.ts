/**
 * Turns the live sighting stream into a short-lived "activity at this camera"
 * signal for the map.
 *
 * Each camera keeps a generation counter rather than a boolean: the generation is
 * part of the pulse's React key, so a second sighting at the same camera remounts
 * the marker and replays the CSS animation. With a boolean, the animation would
 * fire once and every subsequent sighting at that camera would be invisible.
 *
 * Entries expire so a camera that has gone quiet stops glowing.
 */

import { useEffect, useRef, useState } from 'react';

import { useLive } from './LiveProvider';

const PULSE_TTL_MS = 2000;

export function usePulses(): ReadonlyMap<string, number> {
  const { liveSightings } = useLive();
  const [pulses, setPulses] = useState<Map<string, number>>(new Map());
  const generation = useRef(0);
  const lastSeenId = useRef<string | null>(null);

  useEffect(() => {
    const newest = liveSightings[0];
    if (!newest || newest.sighting_id === lastSeenId.current) return;
    lastSeenId.current = newest.sighting_id;

    generation.current += 1;
    const id = generation.current;
    const code = newest.camera_code;

    setPulses((current) => {
      const next = new Map(current);
      next.set(code, id);
      return next;
    });

    const timer = setTimeout(() => {
      setPulses((current) => {
        // Only clear if this generation is still the latest for that camera —
        // otherwise a newer pulse would be cancelled by an older timer.
        if (current.get(code) !== id) return current;
        const next = new Map(current);
        next.delete(code);
        return next;
      });
    }, PULSE_TTL_MS);

    return () => clearTimeout(timer);
  }, [liveSightings]);

  return pulses;
}
