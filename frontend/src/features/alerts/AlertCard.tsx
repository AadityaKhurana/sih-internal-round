import { CameraIcon, CheckIcon, ClockIcon } from '@/components/icons';
import { Badge, Button } from '@/components/ui';
import { cx } from '@/lib/cx';
import { formatPlate } from '@/lib/plate';
import { formatRelative, formatTime } from '@/lib/time';
import type { Alert } from '@/types/domain';
import {
  ALERT_STATUS_TONE,
  alertAccent,
  alertFigures,
  alertReason,
  alertTitle,
  alertTone,
  isOpen,
} from './alert-format';

export interface AlertCardProps {
  alert: Alert;
  selected?: boolean;
  /** Play the arrival flash — only for alerts that landed this session. */
  fresh?: boolean;
  compact?: boolean;
  onSelect?: (alert: Alert) => void;
  onAcknowledge?: (alert: Alert) => void;
  onShowTrajectory?: (plate: string) => void;
  onLocate?: (alert: Alert) => void;
}

export function AlertCard({
  alert,
  selected = false,
  fresh = false,
  compact = false,
  onSelect,
  onAcknowledge,
  onShowTrajectory,
  onLocate,
}: AlertCardProps) {
  const figures = alertFigures(alert);
  const open = isOpen(alert);

  return (
    // A div with a role rather than a <button>: the card contains its own
    // buttons, and nesting interactive elements inside a button is invalid.
    <div
      className={cx(
        'alert-card',
        `alert-card--${alertAccent(alert)}`,
        alert.status === 'new' && 'is-new',
        fresh && 'is-fresh',
        selected && 'is-selected',
      )}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-pressed={onSelect ? selected : undefined}
      onClick={onSelect ? () => onSelect(alert) : undefined}
      onKeyDown={
        onSelect
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(alert);
              }
            }
          : undefined
      }
    >
      <div className="alert-card__top">
        <Badge tone={alertTone(alert)}>{alertTitle(alert)}</Badge>
        <span className="alert-card__plate">
          {formatPlate(alert.normalized_plate)}
        </span>
        {alert.status !== 'new' ? (
          <Badge tone={ALERT_STATUS_TONE[alert.status]}>{alert.status}</Badge>
        ) : (
          <Badge tone="danger" dot pulse>
            new
          </Badge>
        )}
        <time
          className="alert-card__time"
          dateTime={alert.created_at}
          title={formatTime(alert.created_at)}
        >
          {formatRelative(alert.created_at)}
        </time>
      </div>

      <p className="alert-card__reason">{alertReason(alert)}</p>

      <div className="alert-card__where">
        <CameraIcon size={12} />
        <span className="u-num">{alert.camera_code}</span>
        <span className="u-truncate">{alert.camera_display_name}</span>
        {alert.previous_camera_code ? (
          <>
            <span aria-hidden="true">·</span>
            <span>
              from <span className="u-num">{alert.previous_camera_code}</span>
            </span>
          </>
        ) : null}
      </div>

      {!compact && figures.length > 0 ? (
        <dl className="alert-card__evidence">
          {figures.map((figure) => (
            <div key={figure.label} style={{ display: 'contents' }}>
              <dt className="u-dim">{figure.label}</dt>
              <dd
                className="u-num"
                style={figure.bad ? { color: 'var(--c-danger)' } : undefined}
              >
                {figure.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {alert.acknowledged_by ? (
        <span className="alert-card__ack">
          <CheckIcon size={12} />
          {alert.status === 'resolved' ? 'Resolved' : 'Acknowledged'} by{' '}
          <span className="u-num">{alert.acknowledged_by}</span>
          {alert.acknowledged_at ? (
            <>
              {' · '}
              <ClockIcon size={11} /> {formatRelative(alert.acknowledged_at)}
            </>
          ) : null}
        </span>
      ) : null}

      {alert.resolution_notes ? (
        <p className="alert-card__reason u-dim">“{alert.resolution_notes}”</p>
      ) : null}

      {onAcknowledge || onShowTrajectory || onLocate ? (
        <div
          className="alert-card__actions"
          // Actions must not re-trigger the card's own select handler.
          onClick={(event) => event.stopPropagation()}
        >
          {onAcknowledge && open ? (
            <Button
              size="xs"
              variant="primary"
              onClick={() => onAcknowledge(alert)}
            >
              Acknowledge
            </Button>
          ) : null}
          {onShowTrajectory && alert.normalized_plate ? (
            <Button
              size="xs"
              onClick={() => onShowTrajectory(alert.normalized_plate!)}
            >
              Trajectory
            </Button>
          ) : null}
          {onLocate ? (
            <Button size="xs" variant="ghost" onClick={() => onLocate(alert)}>
              Locate
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
