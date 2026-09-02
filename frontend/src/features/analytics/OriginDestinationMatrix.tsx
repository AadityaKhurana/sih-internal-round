import { useMemo } from 'react';

import { EmptyState } from '@/components/ui';
import { formatDuration } from '@/lib/time';
import type { OriginDestinationResponse } from '@/types/api';
import './analytics.css';

export interface OriginDestinationMatrixProps {
  data: OriginDestinationResponse;
  onSelectPair?: (from: string, to: string) => void;
}

/**
 * Origin–destination matrix.
 *
 * A cell is a completed *journey* — where a trip started and where it ended — not
 * a link traversal, so the diagonal is empty by definition and the totals are
 * trips rather than passes. Cells are shaded relative to the busiest pair; an
 * unobserved pair is explicitly styled as empty rather than as a zero, because
 * "no trips" and "no coverage" are not the same claim.
 */
export function OriginDestinationMatrix({
  data,
  onSelectPair,
}: OriginDestinationMatrixProps) {
  const byPair = useMemo(() => {
    const map = new Map<string, (typeof data.pairs)[number]>();
    for (const pair of data.pairs) {
      map.set(`${pair.from_camera_code}->${pair.to_camera_code}`, pair);
    }
    return map;
  }, [data.pairs]);

  const max = useMemo(
    () => data.pairs.reduce((peak, pair) => Math.max(peak, pair.journey_count), 0),
    [data.pairs],
  );

  if (data.pairs.length === 0) {
    return (
      <EmptyState
        icon="⬚"
        title="No completed journeys in this window"
        body="A journey needs a first and a last camera pass for the same plate. Widen the window."
      />
    );
  }

  return (
    <>
      <p className="ui-field__hint" style={{ marginBottom: 'var(--sp-2)' }}>
        Rows are origins, columns are destinations. {data.total_journeys.toLocaleString()}{' '}
        journeys, busiest pair {max}. Cells show journey counts; hover for median
        travel time.
      </p>
      <div className="od-wrap">
        <table className="od-table">
          <thead>
            <tr>
              <th scope="col">from ↓ / to →</th>
              {data.camera_codes.map((code) => (
                <th key={code} scope="col">
                  {code.replace('CAM-', '')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.camera_codes.map((origin) => (
              <tr key={origin}>
                <th scope="row">{origin}</th>
                {data.camera_codes.map((destination) => {
                  if (origin === destination) {
                    return (
                      <td
                        key={destination}
                        className="od-cell od-cell--diagonal"
                        aria-label={`${origin} to itself, not applicable`}
                      />
                    );
                  }

                  const pair = byPair.get(`${origin}->${destination}`);
                  if (!pair) {
                    return (
                      <td
                        key={destination}
                        className="od-cell od-cell--empty"
                        title={`No journeys observed from ${origin} to ${destination}`}
                      >
                        ·
                      </td>
                    );
                  }

                  const share = max > 0 ? pair.journey_count / max : 0;
                  return (
                    <td
                      key={destination}
                      className="od-cell"
                      style={{
                        background: `rgba(56, 189, 248, ${(0.12 + share * 0.78).toFixed(3)})`,
                        cursor: onSelectPair ? 'pointer' : 'default',
                        color: share > 0.5 ? 'var(--c-text-inverse)' : 'var(--c-text)',
                      }}
                      title={`${origin} → ${destination}: ${pair.journey_count} journeys, ${pair.share_pct}% of trips from ${origin}, median ${formatDuration(pair.median_travel_time_seconds)}`}
                      onClick={onSelectPair ? () => onSelectPair(origin, destination) : undefined}
                    >
                      {pair.journey_count}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
