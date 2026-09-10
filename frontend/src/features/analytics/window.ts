/**
 * Shared analytics time window.
 *
 * Every window is snapped to a 5-minute boundary. Two reasons: the metric tables
 * are keyed to 5-minute windows so a sub-window range is meaningless, and an
 * un-snapped `to = Date.now()` would produce a new React Query key on every
 * render and refetch forever.
 */

import { useMemo, useState } from 'react';

import { FIVE_MIN_MS } from '@/lib/time';
import type { AnalyticsWindowQuery } from '@/types/api';

export interface WindowPreset {
  value: string;
  label: string;
  hours: number;
  /** Sensible trend bucket for a window this wide. */
  bucketMinutes: number;
}

export const WINDOW_PRESETS: readonly WindowPreset[] = [
  { value: '1h', label: 'Last hour', hours: 1, bucketMinutes: 5 },
  { value: '3h', label: 'Last 3 hours', hours: 3, bucketMinutes: 15 },
  { value: '12h', label: 'Last 12 hours', hours: 12, bucketMinutes: 30 },
  { value: '24h', label: 'Last 24 hours', hours: 24, bucketMinutes: 60 },
  { value: '3d', label: 'Last 3 days', hours: 72, bucketMinutes: 180 },
  { value: '7d', label: 'Last 7 days', hours: 168, bucketMinutes: 360 },
];

export interface AnalyticsWindow {
  preset: WindowPreset;
  query: AnalyticsWindowQuery;
  bucketMinutes: number;
  setPreset: (value: string) => void;
}

export function useAnalyticsWindow(initial = '3h'): AnalyticsWindow {
  const [value, setValue] = useState(initial);

  const preset =
    WINDOW_PRESETS.find((option) => option.value === value) ?? WINDOW_PRESETS[1]!;

  // Snapped, and memoised on the preset alone, so the query key is stable for as
  // long as the operator leaves the selection alone.
  const query = useMemo<AnalyticsWindowQuery>(() => {
    const to = Math.floor(Date.now() / FIVE_MIN_MS) * FIVE_MIN_MS;
    return {
      from: new Date(to - preset.hours * 3_600_000).toISOString(),
      to: new Date(to).toISOString(),
    };
  }, [preset]);

  return {
    preset,
    query,
    bucketMinutes: preset.bucketMinutes,
    setPreset: setValue,
  };
}
