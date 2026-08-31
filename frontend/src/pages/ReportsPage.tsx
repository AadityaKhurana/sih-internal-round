import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { useReport, useReportPeriods } from '@/api/hooks';
import { DownloadIcon } from '@/components/icons';
import { SimulatedNetworkNotice } from '@/components/SimulatedNetworkNotice';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Loading,
  SegmentedControl,
  Select,
  StatTile,
} from '@/components/ui';
import { HourlyHeatmap } from '@/features/reports/HourlyHeatmap';
import { downloadCsv, toCsv } from '@/features/reports/csv';
import { ANOMALY_REASON_LABEL } from '@/features/alerts/alert-format';
import {
  CONGESTION_LEGEND,
  formatCount,
  formatPercentDelta,
  formatScore,
  isLowSample,
} from '@/lib/congestion';
import { Legend } from '@/components/ui';
import { formatDistance, formatSpeed } from '@/lib/geo';
import { formatDate, formatDuration } from '@/lib/time';
import type { CongestionReport, ReportGranularity } from '@/types/domain';
import '@/features/analytics/analytics.css';
import '@/features/reports/reports.css';

const GRANULARITIES = [
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
] as const;

const HEATMAP_METRICS = [
  { value: 'congestion', label: 'Congestion' },
  { value: 'volume', label: 'Volume' },
] as const;

/**
 * Weekly and monthly congestion reporting.
 *
 * Built for someone who has to justify a decision, not just glance at a number, so
 * every headline figure is paired with the previous period and every table is
 * exportable. Deltas are colour-coded by whether they are *bad*, not by sign:
 * congestion rising and throughput rising are not the same news.
 */
export function ReportsPage() {
  const [granularity, setGranularity] = useState<ReportGranularity>('week');
  const [period, setPeriod] = useState<string | undefined>(undefined);
  const [heatmapMetric, setHeatmapMetric] = useState<'congestion' | 'volume'>('congestion');

  const periods = useReportPeriods(granularity);
  const report = useReport(granularity, period);

  // Reset to the latest period when switching granularity, otherwise a week label
  // would be sent to the month endpoint.
  useEffect(() => {
    setPeriod(undefined);
  }, [granularity]);

  const dailyRows = useMemo(
    () =>
      (report.data?.daily_series ?? []).map((point) => ({
        date: point.date,
        label: formatDate(point.date),
        vehicles: point.vehicle_count,
        baseline: point.baseline_vehicle_count,
        score: point.avg_congestion_score,
      })),
    [report.data],
  );

  const exportWorstLinks = () => {
    if (!report.data) return;
    const csv = toCsv(
      [
        'from_camera_code',
        'to_camera_code',
        'road_name',
        'direction_label',
        'distance_meters',
        'free_flow_time_seconds',
        'median_travel_time_seconds',
        'baseline_travel_time_seconds',
        'congestion_score',
        'derived_speed_kph',
        'vehicle_count',
        'travel_time_sample_count',
      ],
      report.data.worst_links.map((link) => [
        link.from_camera_code,
        link.to_camera_code,
        link.road_name,
        link.direction_label,
        link.distance_meters,
        link.free_flow_time_seconds,
        link.median_travel_time_seconds,
        link.baseline_travel_time_seconds,
        link.congestion_score,
        link.derived_speed_kph?.toFixed(2) ?? '',
        link.vehicle_count,
        link.travel_time_sample_count,
      ]),
    );
    downloadCsv(`anpr-worst-links-${report.data.period.label.replace(/\s+/g, '-')}.csv`, csv);
  };

  const exportDaily = () => {
    if (!report.data) return;
    const csv = toCsv(
      ['date', 'vehicle_count', 'baseline_vehicle_count', 'avg_congestion_score'],
      report.data.daily_series.map((point) => [
        point.date,
        point.vehicle_count,
        point.baseline_vehicle_count,
        point.avg_congestion_score,
      ]),
    );
    downloadCsv(`anpr-daily-${report.data.period.label.replace(/\s+/g, '-')}.csv`, csv);
  };

  return (
    <div className="page">
      <SimulatedNetworkNotice detail="Figures are aggregated from generated observations over the simulated network, not from real traffic." />

      <div className="report-head">
        <SegmentedControl
          ariaLabel="Report granularity"
          value={granularity}
          options={GRANULARITIES}
          onChange={setGranularity}
        />

        <Select
          label="Period"
          small
          value={period ?? (periods.data?.periods[0]?.period ?? '')}
          options={(periods.data?.periods ?? []).map((option) => ({
            value: option.period,
            label: option.label,
          }))}
          onChange={(event) => setPeriod(event.target.value)}
        />

        <span className="u-grow" />

        <Button size="sm" onClick={exportDaily} disabled={!report.data}>
          <DownloadIcon size={13} /> Daily CSV
        </Button>
        <Button size="sm" onClick={exportWorstLinks} disabled={!report.data}>
          <DownloadIcon size={13} /> Links CSV
        </Button>
      </div>

      {report.isLoading ? (
        <Loading label="Aggregating the reporting period…" />
      ) : report.isError ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : report.data ? (
        <ReportBody
          data={report.data}
          dailyRows={dailyRows}
          heatmapMetric={heatmapMetric}
          onHeatmapMetricChange={setHeatmapMetric}
        />
      ) : (
        <EmptyState icon="⬚" title="No report for this period" />
      )}
    </div>
  );
}

interface DailyRow {
  date: string;
  label: string;
  vehicles: number;
  baseline: number | null;
  score: number | null;
}

function ReportBody({
  data,
  dailyRows,
  heatmapMetric,
  onHeatmapMetricChange,
}: {
  data: CongestionReport;
  dailyRows: DailyRow[];
  heatmapMetric: 'congestion' | 'volume';
  onHeatmapMetricChange: (metric: 'congestion' | 'volume') => void;
}) {
  return (
    <>
      <div className="page__grid page__grid--stats">
        <StatTile
          label="Period"
          value={data.period.label}
          footNote={`${formatDate(data.period.from)} → ${formatDate(data.period.to)}`}
        />
        <StatTile
          label="Vehicles recorded"
          value={formatCount(data.summary.total_sightings)}
          deltaPct={data.comparison?.volume_delta_pct ?? null}
          deltaPolarity="up-is-good"
          footNote={
            data.comparison ? `vs ${data.comparison.previous_label}` : 'no prior period'
          }
        />
        <StatTile
          label="Avg congestion"
          value={formatScore(data.summary.avg_congestion_score)}
          unit="×"
          deltaPct={data.comparison?.congestion_delta_pct ?? null}
          deltaPolarity="up-is-bad"
          footNote="vs free flow"
        />
        <StatTile
          label="Peak congestion"
          value={formatScore(data.summary.peak_congestion_score)}
          unit="×"
          footNote="worst single link-window"
        />
        <StatTile
          label="Total delay"
          value={data.summary.total_delay_hours?.toFixed(1) ?? '—'}
          unit="h"
          footNote="over the window-of-week baseline"
        />
        <StatTile
          label="Alerts raised"
          value={formatCount(data.summary.alert_count)}
          footNote="blacklist + anomaly"
        />
      </div>

      {data.comparison ? (
        <div className="report-compare">
          <span>
            Against <strong>{data.comparison.previous_label}</strong>: congestion{' '}
            <span
              className={
                (data.comparison.congestion_delta_pct ?? 0) > 1
                  ? 'report-delta--worse'
                  : (data.comparison.congestion_delta_pct ?? 0) < -1
                    ? 'report-delta--better'
                    : 'report-delta--flat'
              }
            >
              {formatPercentDelta(data.comparison.congestion_delta_pct)}
            </span>
            , volume{' '}
            <span className="report-delta--flat">
              {formatPercentDelta(data.comparison.volume_delta_pct)}
            </span>
            . Busiest camera{' '}
            <strong className="u-num">{data.summary.busiest_camera_code ?? '—'}</strong>,
            worst corridor <strong>{data.summary.worst_link_label ?? '—'}</strong>.
          </span>
        </div>
      ) : null}

      <Card
        title="Daily volume and congestion"
        subtitle="Bars are vehicles recorded, the line is average congestion against free flow"
      >
        <div className="chart-wrap chart-wrap--tall">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={dailyRows} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
              <CartesianGrid stroke="var(--c-border)" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="label" stroke="var(--c-border-strong)" minTickGap={12} />
              <YAxis yAxisId="v" stroke="var(--c-border-strong)" width={62} />
              <YAxis
                yAxisId="s"
                orientation="right"
                stroke="var(--c-border-strong)"
                width={40}
                domain={[1, 'auto']}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const row = payload[0]?.payload as DailyRow | undefined;
                  if (!row) return null;
                  return (
                    <div className="chart-tooltip">
                      <div className="chart-tooltip__title">{row.label}</div>
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
                            {row.score.toFixed(2)}×
                          </span>
                        </div>
                      ) : null}
                    </div>
                  );
                }}
              />
              <Bar
                yAxisId="v"
                dataKey="vehicles"
                name="Vehicles"
                fill="rgba(56, 189, 248, 0.55)"
                isAnimationActive={false}
              />
              <Line
                yAxisId="v"
                type="monotone"
                dataKey="baseline"
                name="Baseline"
                stroke="var(--c-text-dim)"
                strokeDasharray="4 4"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                yAxisId="s"
                type="monotone"
                dataKey="score"
                name="Congestion"
                stroke="#fb923c"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card
        title="When the corridor is congested"
        subtitle="Day of week against hour of day, averaged over the period"
        actions={
          <SegmentedControl
            ariaLabel="Heatmap metric"
            value={heatmapMetric}
            options={HEATMAP_METRICS}
            onChange={onHeatmapMetricChange}
          />
        }
      >
        <div className="heatmap-scroll">
          <HourlyHeatmap cells={data.hourly_profile} metric={heatmapMetric} />
        </div>
        {heatmapMetric === 'congestion' ? (
          <div style={{ marginTop: 'var(--sp-3)' }}>
            <Legend items={CONGESTION_LEGEND} />
          </div>
        ) : null}
        <p className="ui-field__hint" style={{ marginTop: 'var(--sp-2)' }}>
          Hatched cells had no matched journeys in that hour across the period — no
          measurement, which is not the same as no congestion.
        </p>
      </Card>

      <div className="page__grid page__grid--2">
        <Card
          title="Worst corridors this period"
          subtitle="Ranked by travel time against free flow"
        >
          <DataTable dense>
            <thead>
              <tr>
                <th scope="col">Link</th>
                <th scope="col">Corridor</th>
                <th scope="col" className="is-num">
                  Score
                </th>
                <th scope="col" className="is-num">
                  Median
                </th>
                <th scope="col" className="is-num">
                  Speed
                </th>
                <th scope="col" className="is-num">
                  Matched
                </th>
              </tr>
            </thead>
            <tbody>
              {data.worst_links.map((link) => (
                <tr key={link.camera_link_id}>
                  <td className="u-num">
                    {link.from_camera_code} → {link.to_camera_code}
                  </td>
                  <td className="u-dim">
                    {link.road_name ?? '—'}
                    <br />
                    <span style={{ fontSize: 'var(--fs-2xs)' }}>
                      {formatDistance(link.distance_meters)}
                    </span>
                  </td>
                  <td className="is-num">{formatScore(link.congestion_score)}</td>
                  <td className="is-num">
                    {formatDuration(link.median_travel_time_seconds)}
                    {link.baseline_travel_time_seconds !== null ? (
                      <>
                        <br />
                        <span className="u-dim" style={{ fontSize: 'var(--fs-2xs)' }}>
                          base {formatDuration(link.baseline_travel_time_seconds)}
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td className="is-num">{formatSpeed(link.derived_speed_kph)}</td>
                  <td className="is-num">
                    <span
                      className={
                        isLowSample(link.travel_time_sample_count)
                          ? 'sample-warning'
                          : undefined
                      }
                    >
                      {formatCount(link.travel_time_sample_count)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Card>

        <Card title="Alerts by type" subtitle="What the period's alerts were for">
          {data.alerts_by_type.length === 0 ? (
            <EmptyState icon="✓" title="No alerts in this period" />
          ) : (
            <div className="u-col" style={{ gap: 'var(--sp-2)' }}>
              {data.alerts_by_type.map((entry) => {
                const total = data.alerts_by_type.reduce((sum, item) => sum + item.count, 0);
                const share = total > 0 ? entry.count / total : 0;
                return (
                  <div key={`${entry.alert_type}-${entry.anomaly_reason ?? 'none'}`}>
                    <div className="u-row-between" style={{ marginBottom: 2 }}>
                      <span className="u-row" style={{ gap: 'var(--sp-2)' }}>
                        <Badge tone={entry.alert_type === 'blacklist' ? 'danger' : 'violet'}>
                          {entry.alert_type === 'blacklist' ? 'Blacklist' : 'Anomaly'}
                        </Badge>
                        <span style={{ fontSize: 'var(--fs-xs)' }}>
                          {entry.anomaly_reason
                            ? ANOMALY_REASON_LABEL[entry.anomaly_reason]
                            : 'Active entry matched'}
                        </span>
                      </span>
                      <span className="u-num" style={{ fontSize: 'var(--fs-xs)' }}>
                        {entry.count} · {(share * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div className="ui-meter">
                      <span
                        className="ui-meter__fill"
                        style={{
                          width: `${(share * 100).toFixed(1)}%`,
                          background:
                            entry.alert_type === 'blacklist'
                              ? 'var(--c-danger)'
                              : 'var(--c-violet)',
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
