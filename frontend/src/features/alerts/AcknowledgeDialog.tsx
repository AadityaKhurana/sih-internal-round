import { useEffect, useState } from 'react';

import { useAcknowledgeAlert } from '@/api/hooks';
import { getOperatorSubject } from '@/api/operator';
import { Badge, Button, Modal, Select, TextArea } from '@/components/ui';
import { formatPlate } from '@/lib/plate';
import { formatDateTime } from '@/lib/time';
import type { Alert, AlertStatus } from '@/types/domain';
import { alertReason, alertTitle, alertTone } from './alert-format';

export interface AcknowledgeDialogProps {
  alert: Alert | null;
  onClose: () => void;
  onDone?: (alert: Alert) => void;
}

type Disposition = Extract<AlertStatus, 'acknowledged' | 'resolved'>;

const DISPOSITIONS = [
  { value: 'acknowledged', label: 'Acknowledged — keep open for follow-up' },
  { value: 'resolved', label: 'Resolved — no further action' },
] as const;

/**
 * Acknowledgement is an auditable action, not a dismissal: it writes
 * `acknowledged_by` / `acknowledged_at` and is expected to append to
 * `audit_logs`. The dialog therefore states who it will be recorded against
 * rather than doing it silently, and asks for a disposition instead of collapsing
 * "I've seen this" and "this is closed" into one button.
 */
export function AcknowledgeDialog({ alert, onClose, onDone }: AcknowledgeDialogProps) {
  const acknowledge = useAcknowledgeAlert();
  const [notes, setNotes] = useState('');
  const [disposition, setDisposition] = useState<Disposition>('acknowledged');
  const operator = getOperatorSubject();

  // Reset the form whenever a different alert is opened.
  useEffect(() => {
    setNotes('');
    setDisposition('acknowledged');
    acknowledge.reset();
    // `acknowledge` is a stable mutation object from React Query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alert?.alert_id]);

  if (!alert) return null;

  const submit = () => {
    acknowledge.mutate(
      {
        alertId: alert.alert_id,
        body: {
          acknowledged_by: operator,
          status: disposition,
          ...(notes.trim().length > 0 ? { resolution_notes: notes.trim() } : {}),
        },
      },
      {
        onSuccess: (updated) => {
          onDone?.(updated);
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="u-row">
          Acknowledge alert
          <Badge tone={alertTone(alert)}>{alertTitle(alert)}</Badge>
        </span>
      }
      footer={
        <>
          <Button onClick={onClose} disabled={acknowledge.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={acknowledge.isPending}>
            {disposition === 'resolved' ? 'Resolve alert' : 'Acknowledge'}
          </Button>
        </>
      }
    >
      <div className="u-col" style={{ gap: 'var(--sp-4)' }}>
        <div className="ui-kv">
          <span className="ui-kv__k">Plate</span>
          <span className="ui-kv__v u-num">{formatPlate(alert.normalized_plate)}</span>
          <span className="ui-kv__k">Camera</span>
          <span className="ui-kv__v">
            <span className="u-num">{alert.camera_code}</span> ·{' '}
            {alert.camera_display_name}
          </span>
          <span className="ui-kv__k">Spotted</span>
          <span className="ui-kv__v u-num">{formatDateTime(alert.spotted_at)}</span>
          <span className="ui-kv__k">Reason</span>
          <span className="ui-kv__v">{alertReason(alert)}</span>
        </div>

        <Select
          label="Disposition"
          options={DISPOSITIONS}
          value={disposition}
          onChange={(event) => setDisposition(event.target.value as Disposition)}
        />

        <TextArea
          label="Resolution notes"
          placeholder="What was done, or why no action was needed."
          hint="Optional, but the only place the reasoning is captured."
          value={notes}
          maxLength={500}
          onChange={(event) => setNotes(event.target.value)}
        />

        <p className="ui-field__hint">
          Recorded against <strong className="u-num">{operator}</strong>. This identity
          is not authenticated — it is the placeholder the dashboard sends until auth
          exists.
        </p>

        {acknowledge.isError ? (
          <p className="ui-field__error" role="alert">
            {acknowledge.error instanceof Error
              ? acknowledge.error.message
              : 'Could not acknowledge this alert.'}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
