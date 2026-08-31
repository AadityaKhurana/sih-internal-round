import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { CONNECTION_LABEL } from '@/api/live';
import {
  KNOWN_OPERATORS,
  getOperatorSubject,
  setOperatorSubject,
  subscribeOperatorSubject,
} from '@/api/operator';
import { BellIcon } from '@/components/icons';
import { Button } from '@/components/ui';
import { useLive } from '@/features/live/LiveProvider';
import { cx } from '@/lib/cx';
import { formatRelative } from '@/lib/time';
import { routeMetaFor } from './routes';

interface HeaderProps {
  dockOpen: boolean;
  onToggleDock: () => void;
}

/** Live-feed status pill. States are distinguished by colour *and* wording. */
function ConnectionPill() {
  const { state, lastMessageAt } = useLive();
  const [, forceTick] = useState(0);

  // Re-render every 5s so "12s ago" stays honest without a global timer.
  useEffect(() => {
    const timer = setInterval(() => forceTick((n) => n + 1), 5000);
    return () => clearInterval(timer);
  }, []);

  const title =
    lastMessageAt === null
      ? 'No frames received yet'
      : `Last frame ${formatRelative(lastMessageAt)}`;

  return (
    <span className={cx('conn', `conn--${state}`)} title={title} role="status">
      <span
        className={cx(
          'conn__dot',
          (state === 'open' || state === 'mock') && 'conn__dot--live',
        )}
        aria-hidden="true"
      />
      {CONNECTION_LABEL[state]}
    </span>
  );
}

/**
 * Operator identity picker.
 *
 * This is not authentication and is styled to say so (dashed border, "acting as").
 * It exists because `audit_logs.user_subject` is NOT NULL and acknowledgements
 * record who acted, so the client must supply a subject. See api/operator.ts.
 */
function OperatorPicker() {
  const [subject, setSubject] = useState(getOperatorSubject);

  useEffect(() => subscribeOperatorSubject(setSubject), []);

  return (
    <span
      className="operator"
      title="Unverified identity — a placeholder until authentication is added. Sent as X-Operator-Subject and recorded on acknowledgements."
    >
      <span className="operator__label">Acting as</span>
      <label>
        <span className="u-visually-hidden">Operator identity (unverified)</span>
        <select
          className="operator__select"
          value={subject}
          onChange={(event) => setOperatorSubject(event.target.value)}
        >
          {KNOWN_OPERATORS.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
    </span>
  );
}

export function Header({ dockOpen, onToggleDock }: HeaderProps) {
  const { pathname } = useLocation();
  const meta = routeMetaFor(pathname);
  const { unseenCount } = useLive();

  return (
    <header className="shell__header">
      <div className="header__title">
        <h1 className="header__page">{meta?.label ?? 'ANPR Control'}</h1>
        <p className="header__desc u-truncate">{meta?.description ?? ''}</p>
      </div>

      <span className="header__spacer" />

      <div className="header__group">
        <ConnectionPill />
        <OperatorPicker />
        <span className="dock-toggle">
          <Button
            variant={dockOpen ? 'default' : 'ghost'}
            iconOnly
            active={dockOpen}
            onClick={onToggleDock}
            aria-label={dockOpen ? 'Hide the alert dock' : 'Show the alert dock'}
            aria-expanded={dockOpen}
          >
            <BellIcon size={16} />
          </Button>
          {!dockOpen && unseenCount > 0 ? (
            <span className="dock-toggle__badge" aria-hidden="true">
              {unseenCount > 9 ? '9+' : unseenCount}
            </span>
          ) : null}
        </span>
      </div>
    </header>
  );
}
