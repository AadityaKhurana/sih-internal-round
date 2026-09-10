import { useMemo } from 'react';

import {
  CAMERA_STATUS_TONE,
  formatCount,
  formatPercentDelta,
} from '@/lib/congestion';
import { Badge, EmptyState, Meter } from '@/components/ui';
import type { NodeMetric } from '@/types/domain';
import './analytics.css';

export interface NodeLoadPanelProps {
  nodes: NodeMetric[];
  maxVehicleCount: number;
  selectedCameraCode?: string | null;
  onSelectCamera?: (code: string) => void;
}

/**
 * Per-camera volume, ranked.
 *
 * The map's heatmap answers "where"; this answers "how much, and is that normal".
 * A camera that is down is listed with a status badge and a zero rather than being
 * dropped, so a gap in the network is visible instead of looking like a quiet
 * junction.
 */
export function NodeLoadPanel({
  nodes,
  maxVehicleCount,
  selectedCameraCode = null,
  onSelectCamera,
}: NodeLoadPanelProps) {
  const sorted = useMemo(
    () => [...nodes].sort((a, b) => b.vehicle_count - a.vehicle_count),
    [nodes],
  );

  if (nodes.length === 0) {
    return <EmptyState icon="⬚" title="No node metrics in this window" />;
  }

  return (
    <div>
      {sorted.map((node) => {
        const offline = node.status === 'fault' || node.status === 'inactive';
        const share = maxVehicleCount > 0 ? node.vehicle_count / maxVehicleCount : 0;

        return (
          <div
            key={node.camera_id}
            className="load-row"
            style={{
              cursor: onSelectCamera ? 'pointer' : 'default',
              background:
                selectedCameraCode === node.camera_code
                  ? 'var(--c-accent-dim)'
                  : undefined,
              borderRadius: 'var(--r-xs)',
            }}
            onClick={onSelectCamera ? () => onSelectCamera(node.camera_code) : undefined}
          >
            <span>
              <span className="load-row__code">{node.camera_code}</span>
            </span>

            <span style={{ minWidth: 0 }}>
              <span className="load-row__name u-truncate" style={{ display: 'block' }}>
                {node.display_name}
              </span>
              {offline ? (
                <Badge tone={CAMERA_STATUS_TONE[node.status]}>{node.status}</Badge>
              ) : (
                <Meter
                  value={share}
                  label={`${node.camera_code} load`}
                  color={
                    share > 0.75
                      ? 'var(--c-congestion-heavy)'
                      : share > 0.45
                        ? 'var(--c-congestion-moderate)'
                        : 'var(--c-accent)'
                  }
                />
              )}
            </span>

            <span className="u-num" style={{ textAlign: 'right' }}>
              {formatCount(node.vehicle_count)}
            </span>

            <span
              className="u-num"
              style={{
                textAlign: 'right',
                color:
                  node.vs_baseline_pct === null
                    ? 'var(--c-text-dim)'
                    : node.vs_baseline_pct > 12
                      ? 'var(--c-danger)'
                      : node.vs_baseline_pct < -12
                        ? 'var(--c-ok)'
                        : 'var(--c-text-dim)',
              }}
              title="Change against the window-of-week baseline"
            >
              {formatPercentDelta(node.vs_baseline_pct)}
            </span>
          </div>
        );
      })}

      <p className="ui-field__hint" style={{ marginTop: 'var(--sp-2)' }}>
        Counts are vehicles recorded, not vehicles present: a camera in maintenance
        captures a fraction of passes, and one in fault captures none.
      </p>
    </div>
  );
}
