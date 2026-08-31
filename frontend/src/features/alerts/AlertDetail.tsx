import { Link } from 'react-router-dom';

import { CameraIcon } from '@/components/icons';
import { Badge, Button, Card, KeyValue } from '@/components/ui';
import { formatConfidence } from '@/lib/congestion';
import { formatPlate } from '@/lib/plate';
import { formatDateTime, formatDuration } from '@/lib/time';
import type { Alert } from '@/types/domain';
import {
  ALERT_STATUS_TONE,
  ANOMALY_REASON_EXPLANATION,
  alertFigures,
  alertReason,
  alertTitle,
  alertTone,
  isOpen,
} from './alert-format';

export interface AlertDetailProps {
  alert: Alert;
  onAcknowledge: (alert: Alert) => void;
  onLocate: (alert: Alert) => void;
}

/**
 * Full triage view for one alert.
 *
 * Leads with *why this fired* — the observed value against the threshold it
 * broke — then the two sightings involved, then the actions. An alert an operator
 * cannot justify is an alert they will learn to ignore, so the evidence comes
 * before the buttons.
 */
export function AlertDetail({ alert, onAcknowledge, onLocate }: AlertDetailProps) {
  const figures = alertFigures(alert);

  return (
    <Card
      title={
        <span className="u-row u-wrap">
          {alertTitle(alert)}
          <Badge tone={alertTone(alert)}>{alert.alert_type.replace('_', ' ')}</Badge>
          <Badge tone={ALERT_STATUS_TONE[alert.status]}>{alert.status}</Badge>
        </span>
      }
      subtitle={formatDateTime(alert.created_at)}
      actions={
        <>
          {isOpen(alert) ? (
            <Button size="sm" variant="primary" onClick={() => onAcknowledge(alert)}>
              Acknowledge
            </Button>
          ) : null}
          <Button size="sm" onClick={() => onLocate(alert)}>
            Locate
          </Button>
        </>
      }
    >
      <div className="u-col" style={{ gap: 'var(--sp-4)' }}>
        <div>
          <span className="u-label">Plate</span>
          <p
            className="u-num"
            style={{ fontSize: 'var(--fs-xl)', letterSpacing: 'var(--tracking-wide)' }}
          >
            {formatPlate(alert.normalized_plate)}
          </p>
          {alert.normalized_plate ? (
            <Link to={`/trajectory?plate=${encodeURIComponent(alert.normalized_plate)}`}>
              Reconstruct this plate's route →
            </Link>
          ) : (
            <p className="ui-field__hint">
              No plate was resolved for the triggering sighting.
            </p>
          )}
        </div>

        <p className="alert-card__reason">{alertReason(alert)}</p>

        {alert.anomaly_reason ? (
          <p className="ui-field__hint">
            {ANOMALY_REASON_EXPLANATION[alert.anomaly_reason]}
          </p>
        ) : null}

        {figures.length > 0 ? (
          <div>
            <span className="u-label">Evidence</span>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: 'var(--sp-2)',
                marginTop: 'var(--sp-2)',
              }}
            >
              {figures.map((figure) => (
                <div
                  key={figure.label}
                  className={figure.bad ? 'detail-figure detail-figure--bad' : 'detail-figure'}
                >
                  <span className="detail-figure__label">{figure.label}</span>
                  <span className="detail-figure__value">{figure.value}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div>
          <span className="u-label">Sightings involved</span>
          <div className="u-col" style={{ gap: 'var(--sp-2)', marginTop: 'var(--sp-2)' }}>
            {alert.previous_camera_code && alert.previous_spotted_at ? (
              <div className="detail-figure">
                <span className="detail-figure__label">
                  <CameraIcon size={11} /> Previous · {alert.previous_camera_code}
                </span>
                <span className="detail-figure__value">
                  {formatDateTime(alert.previous_spotted_at)}
                </span>
                <span className="u-dim" style={{ fontSize: 'var(--fs-2xs)' }}>
                  {formatDuration(
                    (Date.parse(alert.spotted_at) -
                      Date.parse(alert.previous_spotted_at)) /
                      1000,
                  )}{' '}
                  before the trigger
                </span>
              </div>
            ) : null}
            <div className="detail-figure">
              <span className="detail-figure__label">
                <CameraIcon size={11} /> Triggering · {alert.camera_code}
              </span>
              <span className="detail-figure__value">
                {formatDateTime(alert.spotted_at)}
              </span>
              <span className="u-dim" style={{ fontSize: 'var(--fs-2xs)' }}>
                {alert.camera_display_name}
              </span>
            </div>
          </div>
        </div>

        <KeyValue
          className="alert-detail__kv"
          rows={[
            {
              key: 'Confidence',
              value: (
                <span className="u-num">{formatConfidence(alert.match_confidence)}</span>
              ),
            },
            {
              key: 'Delivered',
              value: (
                <span className="u-num">
                  {alert.delivered_at ? formatDateTime(alert.delivered_at) : 'not yet'}
                </span>
              ),
            },
            {
              key: 'Acknowledged',
              value: (
                <span className="u-num">
                  {alert.acknowledged_at
                    ? `${formatDateTime(alert.acknowledged_at)} by ${alert.acknowledged_by}`
                    : '—'}
                </span>
              ),
            },
            ...(alert.resolution_notes
              ? [{ key: 'Notes', value: <span>{alert.resolution_notes}</span> }]
              : []),
            ...(alert.case_reference
              ? [
                  {
                    key: 'Case',
                    value: <span className="u-num">{alert.case_reference}</span>,
                  },
                ]
              : []),
            {
              key: 'Dedup key',
              value: <span className="object-key">{alert.dedup_key}</span>,
            },
          ]}
        />

        <div>
          <span className="u-label">Evidence media</span>
          <div className="evidence-placeholder" style={{ marginTop: 'var(--sp-1)' }}>
            The plate crop lives in object storage. Displaying it needs a signed-URL
            endpoint, which the API does not expose yet.
          </div>
          <p className="object-key" style={{ marginTop: 'var(--sp-2)' }}>
            {alert.plate_crop_object_key ?? 'no crop captured'}
          </p>
        </div>
      </div>
    </Card>
  );
}
