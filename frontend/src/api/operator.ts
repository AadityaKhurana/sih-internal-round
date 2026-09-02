/**
 * Operator identity — a placeholder for authentication, which does not exist yet.
 *
 * `audit_logs.user_subject` is NOT NULL and the alert/blacklist tables record who
 * acted, so the UI has to supply *something*. This is a locally-chosen name kept
 * in `localStorage` and sent as a header. It is deliberately labelled as
 * unverified in the header bar: it identifies, it does not authenticate.
 *
 * When Lane B adds auth, the server should derive the subject from the token and
 * ignore this header. Nothing else in the app needs to change.
 */

const STORAGE_KEY = 'anpr.operator.subject';
const DEFAULT_SUBJECT = 'control.room.1';

/** Names offered in the header picker — mirrors the fixture operators. */
export const KNOWN_OPERATORS = [
  'control.room.1',
  'insp.rao',
  'sub.insp.mehta',
  'analyst.dcosta',
] as const;

const listeners = new Set<(subject: string) => void>();

let current = readInitial();

function readInitial(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? DEFAULT_SUBJECT;
  } catch {
    // Private mode / storage disabled — fall back without breaking the app.
    return DEFAULT_SUBJECT;
  }
}

export function getOperatorSubject(): string {
  return current;
}

export function setOperatorSubject(subject: string): void {
  const trimmed = subject.trim();
  if (trimmed.length === 0) return;
  current = trimmed;
  try {
    window.localStorage.setItem(STORAGE_KEY, trimmed);
  } catch {
    // Non-fatal: the value still applies for this session.
  }
  for (const listener of listeners) listener(trimmed);
}

export function subscribeOperatorSubject(listener: (subject: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
