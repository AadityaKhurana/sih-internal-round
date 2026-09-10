import { useMemo, useState } from 'react';

import {
  CONGESTION_LABELS,
  congestionColorHex,
  congestionLevel,
  formatCount,
  formatScore,
  isLowSample,
} from '@/lib/congestion';
import { formatDistance, formatSpeed } from '@/lib/geo';
import { formatDuration } from '@/lib/time';
import { Badge, DataTable, EmptyState } from '@/components/ui';
import type { LinkCongestion } from '@/types/domain';
import './analytics.css';

type SortKey = 'congestion' | 'speed' | 'volume' | 'delay';

const SORTS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'congestion', label: 'Worst congestion' },
  { key: 'speed', label: 'Slowest' },
  { key: 'volume', label: 'Busiest' },
  { key: 'delay', label: 'Most delay vs baseline' },
];

export interface LinkMetricsTableProps {
  links: LinkCongestion[];
  selectedLinkId?: string | null;
  onSelectLink?: (link: LinkCongestion) => void;
}

/**
 * Per-link congestion and derived speed.
 *
 * `derived_speed_kph` is `distance / median travel time`, computed on read — the
 * schema deliberately stores no average speed. The matched-journey count is shown
 * beside every figure and flagged when it is too small to trust: a 3.2× congestion
 * score from two vehicles is noise, and presenting it identically to one backed by
 * 200 would be misleading.
 */
export function LinkMetricsTable({
  links,
  selectedLinkId = null,
  onSelectLink,
}: LinkMetricsTableProps) {
  const [sort, setSort] = useState<SortKey>('congestion');

  const sorted = useMemo(() => {
    const withData = [...links];
    withData.sort((a, b) => {
      switch (sort) {
        case 'speed': {
          // Nulls last: "no measurement" is not "slowest".
          if (a.derived_speed_kph === null) return 1;
          if (b.derived_speed_kph === null) return -1;
          return a.derived_speed_kph - b.derived_speed_kph;
        }
        case 'volume':
          return b.vehicle_count - a.vehicle_count;
        case 'delay': {
          const delay = (link: LinkCongestion) =>
            link.median_travel_time_seconds !== null &&
            link.baseline_travel_time_seconds !== null
              ? link.median_travel_time_seconds - link.baseline_travel_time_seconds
              : Number.NEGATIVE_INFINITY;
          return delay(b) - delay(a);
        }
        default: {
          if (a.congestion_score === null) return 1;
          if (b.congestion_score === null) return -1;
          return b.congestion_score - a.congestion_score;
        }
      }
    });
    return withData;
  }, [links, sort]);

  if (links.length === 0) {
    return <EmptyState icon="⬚" title="No link metrics in this window" />;
  }

  return (
    <>
      <div className="u-row u-wrap" style={{ gap: 'var(--sp-2)', marginBottom: 'var(--sp-2)' }}>
        <span className="u-label">Sort</span>
        {SORTS.map((option) => (
          <button
            key={option.key}
            type="button"
            className="ui-chip"
            aria-pressed={sort === option.key}
            onClick={() => setSort(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <DataTable dense>
        <thead>
          <tr>
            <th scope="col">Link</th>
            <th scope="col">Corridor</th>
            <th scope="col">State</th>
            <th scope="col" className="is-num">
              Score
            </th>
            <th scope="col" className="is-num">
              Median
            </th>
            <th scope="col" className="is-num">
              Free flow
            </th>
            <th scope="col" className="is-num">
              Speed
            </th>
            <th scope="col" className="is-num">
              Distance
            </th>
            <th scope="col" className="is-num">
              Vehicles
            </th>
            <th scope="col" className="is-num">
              Matched
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((link) => {
            const level = congestionLevel(link.congestion_score);
            const lowSample = isLowSample(link.travel_time_sample_count);

            return (
              <tr
                key={link.camera_link_id}
                className={[
                  onSelectLink ? 'is-clickable' : '',
                  selectedLinkId === link.camera_link_id ? 'is-selected' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={onSelectLink ? () => onSelectLink(link) : undefined}
              >
                <td>
                  <span className="u-num">
                    {link.from_camera_code} → {link.to_camera_code}
                  </span>
                  {link.direction_label ? (
                    <span className="u-dim"> {link.direction_label}</span>
                  ) : null}
                </td>
                <td className="u-dim">{link.road_name ?? '—'}</td>
                <td>
                  <Badge
                    tone="neutral"
                    style={{
                      borderColor: congestionColorHex(level),
                      color: congestionColorHex(level),
                    }}
                  >
                    {CONGESTION_LABELS[level]}
                  </Badge>
                </td>
                <td className="is-num">{formatScore(link.congestion_score)}</td>
                <td className="is-num">
                  {formatDuration(link.median_travel_time_seconds)}
                </td>
                <td className="is-num u-dim">
                  {formatDuration(link.free_flow_time_seconds)}
                </td>
                <td className="is-num">{formatSpeed(link.derived_speed_kph)}</td>
                <td className="is-num u-dim">{formatDistance(link.distance_meters)}</td>
                <td className="is-num">{formatCount(link.vehicle_count)}</td>
                <td className="is-num">
                  <span className={lowSample ? 'sample-warning' : undefined}>
                    {link.travel_time_sample_count}
                    {lowSample ? ' ⚠' : ''}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>

      <p className="ui-field__hint" style={{ marginTop: 'var(--sp-2)' }}>
        Speed is derived on read as distance ÷ median travel time — no average speed
        is stored. <span className="sample-warning">⚠</span> marks links with fewer
        than 5 journeys matched at both ends, where the travel-time figures are not
        reliable.
      </p>
    </>
  );
}
