import { useEffect, useState } from 'react';

import { useCreateBlacklistEntry } from '@/api/hooks';
import { getOperatorSubject } from '@/api/operator';
import { Button, Modal, Select, TextArea, TextInput } from '@/components/ui';
import { formatPlate, isValidPlate, normalizePlate } from '@/lib/plate';
import { SEVERITIES, type Severity } from '@/types/domain';

export interface BlacklistDialogProps {
  open: boolean;
  onClose: () => void;
  /** Pre-fill the plate, e.g. from an alert or a trajectory. */
  initialPlate?: string;
}

const SEVERITY_OPTIONS = SEVERITIES.map((severity) => ({
  value: severity,
  label: severity,
}));

const SEVERITY_GUIDANCE: Record<Severity, string> = {
  low: 'Informational watch. Alerts are recorded but are not expected to prompt a response.',
  medium: 'Follow up when convenient — repeat violations, verification requests.',
  high: 'Active investigation. Expect an operator to act on each hit.',
  critical: 'Immediate response — stolen vehicle, active threat.',
};

/**
 * Add a plate to the blacklist.
 *
 * Two deliberate frictions. A reason is mandatory, because an entry nobody can
 * explain later is an entry nobody can defend. And the plate is validated against
 * the Indian series formats with a warning rather than a hard block — OCR can read
 * an unusual plate, and refusing to watch it would be worse than accepting a typo.
 */
export function BlacklistDialog({ open, onClose, initialPlate = '' }: BlacklistDialogProps) {
  const create = useCreateBlacklistEntry();

  const [plate, setPlate] = useState(initialPlate);
  const [reason, setReason] = useState('');
  const [severity, setSeverity] = useState<Severity>('high');
  const [caseRef, setCaseRef] = useState('');
  const [until, setUntil] = useState('');
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPlate(normalizePlate(initialPlate));
    setReason('');
    setSeverity('high');
    setCaseRef('');
    setUntil('');
    setSubmitted(false);
    create.reset();
    // `create` is a stable mutation object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPlate]);

  const normalized = normalizePlate(plate);
  const plateError =
    submitted && normalized.length < 4 ? 'Enter a plate to watch.' : undefined;
  const reasonError =
    submitted && reason.trim().length === 0 ? 'A reason is required.' : undefined;
  const plateWarning =
    normalized.length >= 4 && !isValidPlate(normalized)
      ? 'Not a recognised Indian series. Allowed, but check for a typo.'
      : undefined;

  const submit = () => {
    setSubmitted(true);
    if (normalized.length < 4 || reason.trim().length === 0) return;

    create.mutate(
      {
        plate: normalized,
        reason: reason.trim(),
        severity,
        added_by: getOperatorSubject(),
        ...(caseRef.trim().length > 0 ? { case_reference: caseRef.trim() } : {}),
        ...(until.length > 0 ? { active_until: new Date(until).toISOString() } : {}),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a blacklist entry"
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={create.isPending}>
            Add entry
          </Button>
        </>
      }
    >
      <div className="u-col" style={{ gap: 'var(--sp-4)' }}>
        <TextInput
          label="Plate"
          mono
          placeholder="KA01AB1234"
          value={plate}
          onChange={(event) => setPlate(normalizePlate(event.target.value))}
          error={plateError}
          hint={plateWarning ?? (normalized ? `Will be stored as ${formatPlate(normalized)}` : undefined)}
          autoComplete="off"
          spellCheck={false}
        />

        <Select
          label="Severity"
          options={SEVERITY_OPTIONS}
          value={severity}
          onChange={(event) => setSeverity(event.target.value as Severity)}
          hint={SEVERITY_GUIDANCE[severity]}
        />

        <TextArea
          label="Reason"
          placeholder="Reported stolen — FIR 214/2026"
          value={reason}
          maxLength={300}
          onChange={(event) => setReason(event.target.value)}
          error={reasonError}
          hint="Recorded on the entry and shown on every alert it raises."
        />

        <TextInput
          label="Case reference"
          mono
          placeholder="FIR-214-2026"
          value={caseRef}
          onChange={(event) => setCaseRef(event.target.value.toUpperCase())}
          hint="Optional. Searchable from the blacklist list."
        />

        <TextInput
          label="Active until"
          type="datetime-local"
          value={until}
          onChange={(event) => setUntil(event.target.value)}
          hint="Leave blank for an open-ended watch. A temporary order should have an end date."
        />

        <p className="ui-field__hint">
          Added by <strong className="u-num">{getOperatorSubject()}</strong> — an
          unverified identity, since authentication does not exist yet.
        </p>

        {create.isError ? (
          <p className="ui-field__error" role="alert">
            {create.error instanceof Error
              ? create.error.message
              : 'Could not create the entry.'}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
