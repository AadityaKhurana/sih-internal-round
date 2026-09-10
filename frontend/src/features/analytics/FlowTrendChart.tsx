import { useMemo } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { congestionColorHex } from '@/lib/congestion';
import { formatDuration, formatShortTime } from '@/lib/time';
import type { FlowTrendResponse } from '@/types/api';
import './analytics.css';

export interface FlowTrendChartProps {
  data: FlowTrendResponse;
  /** Show the congestion series on a second axis. Link scope only. */
  showCongestion?: boolean;
}

interface Row {
  t: number;
  vehicles: number;
  baseline: number | null;
  score: number | null;
  travel: number | null;
}

/**
 * Volume over time with the window-of-week baseline behind it, and optionally the
 * congestion ratio on a second axis.
 *
 * The baseline matters: a spike in vehicle count is only interesting relative to
 * what that hour normally carries. Plotting volume alone invites reading every
 * evening peak as an incident.
 */
export function FlowTrendChart({ data, showCongestion = false }: FlowTrendChartProps) {
  const rows = useMemo<Row[]>(
    () =>
      data.points.map((point) => ({
        t: Date.parse(point.window_start),
        vehicles: point.vehicle_count,
        baseline: point.baseline_vehicle_count,
        score: point.congestion_score,
        travel: point.median_travel_time_seconds,
      })),
    [data.points],
  );

  return (
    <div className="chart-wrap chart-wrap--tall">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid stroke="var(--c-border)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={['dataMin', 'dataMax']}
            scale="time"
            tickFormatter={(value: number) => formatShortTime(value)}
            stroke="var(--c-border-strong)"
            minTickGap={40}
          />
          <YAxis yAxisId="vehicles" stroke="var(--c-border-strong)" width={54} />
          {showCongestion ? (
            <YAxis
              yAxisId="score"
              orientation="right"
              stroke="var(--c-border-strong)"
              width={40}
              domain={[1, 'auto']}
            />
          ) : null}

          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0) return null;
              const row = payload[0]?.payload as Row | undefined;
              if (!row) return null;
              return (
                <div className="chart-tooltip">
                  <div className="chart-tooltip__title">
                    {formatShortTime(Number(label))}
                  </div>
                  <div className="chart-tooltip__row">
                    <span>Vehicles</span>
                    <span className="chart-tooltip__value">
                      {row.vehicles.toLocaleString()}
                    </span>
                  </div>
                  {row.baseline !== null ? (
                    <div className="chart-tooltip__row">
                      <span>Baseline</span>
                      <span className="chart-tooltip__value">
                        {row.baseline.toLocaleString()}
                      </span>
                    </div>
                  ) : null}
                  {row.score !== null ? (
                    <div className="chart-tooltip__row">
                      <span>Congestion</span>
                      <span className="chart-tooltip__value">
                        {row.score.toFixed(2)}× free flow
                      </span>
                    </div>
                  ) : null}
                  {row.travel !== null ? (
                    <div className="chart-tooltip__row">
                      <span>Median transit</span>
                      <span className="chart-tooltip__value">
                        {formatDuration(row.travel)}
                      </span>
                    </div>
                  ) : null}
                </div>
              );
            }}
          />

          <Area
            yAxisId="vehicles"
            type="monotone"
            dataKey="vehicles"
            name="Vehicles"
            stroke="var(--c-accent)"
            fill="rgba(56, 189, 248, 0.16)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            yAxisId="vehicles"
            type="monotone"
            dataKey="baseline"
            name="Baseline"
            stroke="var(--c-text-dim)"
            strokeDasharray="4 4"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          {showCongestion ? (
            <>
              {/* 1.0 is free flow — the line that gives the ratio meaning. */}
              <ReferenceLine
                yAxisId="score"
                y={1}
                stroke="var(--c-congestion-free)"
                strokeDasharray="3 3"
              />
              <Line
                yAxisId="score"
                type="monotone"
                dataKey="score"
                name="Congestion"
                stroke={congestionColorHex('heavy')}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </>
          ) : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
