import type { CSSProperties, ReactNode } from 'react';

import { cx } from '@/lib/cx';

/* --- Spinner / loading ---------------------------------------------------- */

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      className="ui-spinner"
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
    />
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="ui-loading">
      <Spinner size={20} />
      <span>{label}</span>
    </div>
  );
}

/* --- Empty / error -------------------------------------------------------- */

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  tone?: 'neutral' | 'error';
}

export function EmptyState({
  icon,
  title,
  body,
  action,
  tone = 'neutral',
}: EmptyStateProps) {
  return (
    <div className={cx('ui-empty', tone === 'error' && 'ui-empty--error')}>
      {icon ? (
        <span className="ui-empty__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="ui-empty__title">{title}</span>
      {body ? <span className="ui-empty__body">{body}</span> : null}
      {action}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const message =
    error instanceof Error ? error.message : 'Unexpected error talking to the API.';
  return (
    <EmptyState
      tone="error"
      icon="⚠"
      title="Could not load this data"
      body={message}
      action={
        onRetry ? (
          <button type="button" className="ui-btn ui-btn--sm" onClick={onRetry}>
            Retry
          </button>
        ) : undefined
      }
    />
  );
}

/* --- Skeleton ------------------------------------------------------------- */

export function Skeleton({
  height = 14,
  width = '100%',
  radius,
  style,
}: {
  height?: number | string;
  width?: number | string;
  radius?: number;
  style?: CSSProperties;
}) {
  return (
    <span
      className="ui-skeleton"
      aria-hidden="true"
      style={{
        display: 'block',
        height,
        width,
        ...(radius !== undefined ? { borderRadius: radius } : {}),
        ...style,
      }}
    />
  );
}

/* --- Meter ---------------------------------------------------------------- */

export function Meter({
  value,
  max = 1,
  color,
  label,
}: {
  value: number;
  max?: number;
  color?: string;
  label?: string;
}) {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(1, value / max)) * 100;
  return (
    <div
      className="ui-meter"
      role="meter"
      aria-valuenow={Number(value.toFixed(3))}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label ?? 'Value'}
    >
      <span
        className="ui-meter__fill"
        style={{ width: `${pct}%`, ...(color ? { background: color } : {}) }}
      />
    </div>
  );
}
