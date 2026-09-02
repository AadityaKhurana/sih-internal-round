import { SEVERITY_HEX } from '@/lib/congestion';
import { Chip, Select } from '@/components/ui';
import type { AlertCounts, AlertsQuery } from '@/types/api';
import {
  ALERT_STATUSES,
  ALERT_TYPES,
  ANOMALY_REASONS,
  SEVERITIES,
  type AlertStatus,
  type AlertType,
  type AnomalyReason,
  type Severity,
} from '@/types/domain';
import { ANOMALY_REASON_LABEL } from './alert-format';

export interface AlertFiltersProps {
  query: AlertsQuery;
  counts?: AlertCounts | undefined;
  cameraCodes: string[];
  onChange: (next: AlertsQuery) => void;
}

const RANGE_OPTIONS = [
  { value: '1', label: 'Last hour' },
  { value: '6', label: 'Last 6 hours' },
  { value: '24', label: 'Last 24 hours' },
  { value: '72', label: 'Last 3 days' },
  { value: '0', label: 'All time' },
] as const;

/**
 * Filter bar for the alerts list.
 *
 * Multi-select filters are chips rather than a multi-select box: an operator
 * needs to see the current filter state without opening anything, and the counts
 * next to each chip say how much is behind it before they click.
 */
export function AlertFilters({ query, counts, cameraCodes, onChange }: AlertFiltersProps) {
  /** Toggle one value inside an array-valued filter. */
  function toggle<T extends string>(
    key: keyof AlertsQuery,
    value: T,
    current: readonly T[] | undefined,
  ): void {
    const set = new Set(current ?? []);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    const next = [...set];
    onChange({ ...query, [key]: next.length > 0 ? next : undefined, offset: 0 });
  }

  const rangeHours = query.from
    ? String(Math.round((Date.now() - Date.parse(query.from)) / 3_600_000))
    : '0';

  return (
    <div className="u-col" style={{ gap: 'var(--sp-3)' }}>
      <div className="u-row u-wrap" style={{ gap: 'var(--sp-2)' }}>
        <span className="u-label" style={{ minWidth: '4.5rem' }}>
          Type
        </span>
        {ALERT_TYPES.map((type) => (
          <Chip
            key={type}
            pressed={query.alert_type?.includes(type) ?? false}
            onToggle={() => toggle<AlertType>('alert_type', type, query.alert_type)}
            {...(counts
              ? { count: type === 'blacklist' ? counts.blacklist : counts.route_anomaly }
              : {})}
          >
            {type === 'blacklist' ? 'Blacklist' : 'Route anomaly'}
          </Chip>
        ))}
      </div>

      <div className="u-row u-wrap" style={{ gap: 'var(--sp-2)' }}>
        <span className="u-label" style={{ minWidth: '4.5rem' }}>
          Status
        </span>
        {ALERT_STATUSES.map((status) => (
          <Chip
            key={status}
            pressed={query.status?.includes(status) ?? false}
            onToggle={() => toggle<AlertStatus>('status', status, query.status)}
            {...(counts && status !== 'delivered'
              ? {
                  count:
                    status === 'new'
                      ? counts.new
                      : status === 'acknowledged'
                        ? counts.acknowledged
                        : counts.resolved,
                }
              : {})}
          >
            {status}
          </Chip>
        ))}
      </div>

      <div className="u-row u-wrap" style={{ gap: 'var(--sp-2)' }}>
        <span className="u-label" style={{ minWidth: '4.5rem' }}>
          Severity
        </span>
        {SEVERITIES.map((severity) => (
          <Chip
            key={severity}
            pressed={query.severity?.includes(severity) ?? false}
            onToggle={() => toggle<Severity>('severity', severity, query.severity)}
            activeColor={SEVERITY_HEX[severity]}
            {...(counts ? { count: counts.by_severity[severity] } : {})}
          >
            {severity}
          </Chip>
        ))}
        <span className="u-dim" style={{ fontSize: 'var(--fs-2xs)' }}>
          {/* Anomaly alerts have no blacklist entry, so no severity. Saying so
              prevents "my filter hid half the alerts" confusion. */}
          route anomalies carry no severity
        </span>
      </div>

      <div className="u-row u-wrap" style={{ gap: 'var(--sp-2)' }}>
        <span className="u-label" style={{ minWidth: '4.5rem' }}>
          Anomaly
        </span>
        {ANOMALY_REASONS.map((reason) => (
          <Chip
            key={reason}
            pressed={query.anomaly_reason?.includes(reason) ?? false}
            onToggle={() =>
              toggle<AnomalyReason>('anomaly_reason', reason, query.anomaly_reason)
            }
            {...(counts ? { count: counts.by_anomaly_reason[reason] } : {})}
          >
            {ANOMALY_REASON_LABEL[reason]}
          </Chip>
        ))}
      </div>

      <div className="u-row u-wrap" style={{ gap: 'var(--sp-3)', alignItems: 'flex-end' }}>
        <Select
          label="Camera"
          small
          fieldClassName="u-grow"
          value={query.camera_code ?? ''}
          options={[
            { value: '', label: 'All cameras' },
            ...cameraCodes.map((code) => ({ value: code, label: code })),
          ]}
          onChange={(event) =>
            onChange({
              ...query,
              camera_code: event.target.value || undefined,
              offset: 0,
            })
          }
        />

        <Select
          label="Window"
          small
          fieldClassName="u-grow"
          value={rangeHours}
          options={RANGE_OPTIONS}
          onChange={(event) => {
            const hours = Number(event.target.value);
            onChange({
              ...query,
              from:
                hours > 0
                  ? new Date(Date.now() - hours * 3_600_000).toISOString()
                  : undefined,
              offset: 0,
            });
          }}
        />
      </div>
    </div>
  );
}
