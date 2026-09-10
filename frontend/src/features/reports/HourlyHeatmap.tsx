import { useMemo } from 'react';

import { congestionColorHex, congestionLevel } from '@/lib/congestion';
import { DAY_LABELS } from '@/lib/time';
import type { HourlyProfileCell } from '@/types/domain';
import './reports.css';

export interface HourlyHeatmapProps {
  cells: HourlyProfileCell[];
  metric: 'congestion' | 'volume';
}

/**
 * Day-of-week × hour grid.
 *
 * This is the view that turns "the corridor is busy" into "the corridor is busy on
 * weekday evenings", which is the difference between an observation and something
 * a traffic authority can act on. Cells with no measurement are drawn hatched, not
 * green, so an unmonitored hour is never mistaken for a clear one.
 */
export function HourlyHeatmap({ cells, metric }: HourlyHeatmapProps) {
  const grid = useMemo(() => {
    const map = new Map<string, HourlyProfileCell>();
    let maxVolume = 0;
    for (const cell of cells) {
      map.set(`${cell.day_of_week}:${cell.hour}`, cell);
      maxVolume = Math.max(maxVolume, cell.vehicle_count);
    }
    return { map, maxVolume };
  }, [cells]);

  return (
    <div className="heatmap">
      <div className="heatmap__corner" />
      {Array.from({ length: 24 }, (_, hour) => (
        <div className="heatmap__hour" key={`h-${hour}`}>
          {hour % 3 === 0 ? String(hour).padStart(2, '0') : ''}
        </div>
      ))}

      {DAY_LABELS.map((label, day) => (
        <div key={label} style={{ display: 'contents' }}>
          <div className="heatmap__day">{label}</div>
          {Array.from({ length: 24 }, (_, hour) => {
            const cell = grid.map.get(`${day}:${hour}`);
            const hasData =
              cell !== undefined &&
              (metric === 'congestion' ? cell.congestion_score !== null : cell.vehicle_count > 0);

            if (!hasData) {
              return (
                <div
                  key={`${day}-${hour}`}
                  className="heatmap__cell heatmap__cell--empty"
                  title={`${label} ${String(hour).padStart(2, '0')}:00 — no data`}
                />
              );
            }

            const background =
              metric === 'congestion'
                ? congestionColorHex(congestionLevel(cell.congestion_score))
                : `rgba(56, 189, 248, ${(
                    0.1 + (cell.vehicle_count / Math.max(1, grid.maxVolume)) * 0.85
                  ).toFixed(3)})`;

            const title =
              metric === 'congestion'
                ? `${label} ${String(hour).padStart(2, '0')}:00 — ${cell.congestion_score?.toFixed(2)}× free flow, ${cell.vehicle_count.toLocaleString()} vehicles`
                : `${label} ${String(hour).padStart(2, '0')}:00 — ${cell.vehicle_count.toLocaleString()} vehicles`;

            return (
              <div
                key={`${day}-${hour}`}
                className="heatmap__cell"
                style={{ background }}
                title={title}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
