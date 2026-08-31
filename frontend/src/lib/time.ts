/**
 * Time helpers.
 *
 * The API sends RFC 3339 UTC strings. Operators think in local wall-clock time,
 * so display formatters use the browser locale while every value that goes back
 * to the API is re-serialised as UTC ISO.
 *
 * `camera_metrics_5m` / `traffic_metrics_5m` are aligned to 5-minute boundaries,
 * so window maths lives here rather than being re-derived per feature.
 */

export const MINUTE_MS = 60_000;
export const FIVE_MIN_MS = 5 * MINUTE_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/* ------------------------------------------------------------- conversion --- */

export function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

export function toIso(value: string | number | Date): string {
  return toDate(value).toISOString();
}

export function epoch(value: string | number | Date): number {
  return toDate(value).getTime();
}

/* ----------------------------------------------------------------- windows -- */

/** Floor to the containing 5-minute metric window. */
export function floorTo5Min(value: string | number | Date): Date {
  return new Date(Math.floor(epoch(value) / FIVE_MIN_MS) * FIVE_MIN_MS);
}

export function floorToMinutes(value: string | number | Date, minutes: number): Date {
  const size = Math.max(1, minutes) * MINUTE_MS;
  return new Date(Math.floor(epoch(value) / size) * size);
}

export function addMinutes(value: string | number | Date, minutes: number): Date {
  return new Date(epoch(value) + minutes * MINUTE_MS);
}

export function addDays(value: string | number | Date, days: number): Date {
  return new Date(epoch(value) + days * DAY_MS);
}

/** Every 5-minute boundary in `[from, to)`, as epoch millis. */
export function fiveMinuteWindows(
  from: string | number | Date,
  to: string | number | Date,
): number[] {
  const start = floorTo5Min(from).getTime();
  const end = epoch(to);
  const out: number[] = [];
  for (let t = start; t < end; t += FIVE_MIN_MS) out.push(t);
  return out;
}

/** 0 = Monday … 6 = Sunday, matching `HourlyProfileCell.day_of_week`. */
export function isoDayOfWeek(value: string | number | Date): number {
  return (toDate(value).getDay() + 6) % 7;
}

export function startOfDay(value: string | number | Date): Date {
  const d = toDate(value);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Monday 00:00 local of the ISO week containing `value`. */
export function startOfIsoWeek(value: string | number | Date): Date {
  const d = startOfDay(value);
  return new Date(d.getTime() - isoDayOfWeek(d) * DAY_MS);
}

export function startOfMonth(value: string | number | Date): Date {
  const d = toDate(value);
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function endOfMonth(value: string | number | Date): Date {
  const d = toDate(value);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

/** ISO-8601 week label, e.g. `2026-W35`. */
export function isoWeekLabel(value: string | number | Date): string {
  const d = startOfIsoWeek(value);
  // ISO weeks belong to the year containing that week's Thursday.
  const thursday = new Date(d.getTime() + 3 * DAY_MS);
  const year = thursday.getFullYear();
  const firstThursday = new Date(year, 0, 4);
  const firstWeekStart = startOfIsoWeek(firstThursday);
  const week = Math.round((d.getTime() - firstWeekStart.getTime()) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** `2026-08`. */
export function monthKey(value: string | number | Date): string {
  const d = toDate(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/* ---------------------------------------------------------------- display --- */

const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const shortTimeFmt = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateFmt = new Intl.DateTimeFormat(undefined, {
  day: '2-digit',
  month: 'short',
});

const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const longDateFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

export function formatTime(value: string | number | Date | null): string {
  return value === null ? '—' : timeFmt.format(toDate(value));
}

export function formatShortTime(value: string | number | Date | null): string {
  return value === null ? '—' : shortTimeFmt.format(toDate(value));
}

export function formatDate(value: string | number | Date | null): string {
  return value === null ? '—' : dateFmt.format(toDate(value));
}

export function formatDateTime(value: string | number | Date | null): string {
  return value === null ? '—' : dateTimeFmt.format(toDate(value));
}

export function formatLongDate(value: string | number | Date | null): string {
  return value === null ? '—' : longDateFmt.format(toDate(value));
}

/** Compact duration: `2h 14m`, `4m 12s`, `38s`. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const abs = Math.round(Math.abs(seconds));
  const sign = seconds < 0 ? '−' : '';
  if (abs < 60) return `${sign}${abs}s`;
  const minutes = Math.floor(abs / 60);
  const rest = abs % 60;
  if (minutes < 60) return `${sign}${minutes}m${rest > 0 ? ` ${rest}s` : ''}`;
  const hours = Math.floor(minutes / 60);
  const restMin = minutes % 60;
  return `${sign}${hours}h${restMin > 0 ? ` ${restMin}m` : ''}`;
}

/** `just now`, `4m ago`, `2h ago`, `3d ago`. */
export function formatRelative(
  value: string | number | Date | null,
  now: number = Date.now(),
): string {
  if (value === null) return '—';
  const delta = Math.round((now - epoch(value)) / 1000);
  if (delta < 5) return 'just now';
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86_400)}d ago`;
}

/** `<input type="datetime-local">` value for a UTC instant, in local time. */
export function toDateTimeLocalValue(value: string | number | Date): string {
  const d = toDate(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
