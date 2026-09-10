import type { ReactNode, TableHTMLAttributes } from 'react';

import { cx } from '@/lib/cx';

/* --- Table ---------------------------------------------------------------- */

export interface DataTableProps extends TableHTMLAttributes<HTMLTableElement> {
  dense?: boolean;
  wrapClassName?: string;
  children: ReactNode;
}

export function DataTable({
  dense = false,
  className,
  wrapClassName,
  children,
  ...rest
}: DataTableProps) {
  return (
    <div className={cx('ui-table-wrap', wrapClassName)}>
      <table className={cx('ui-table', dense && 'ui-table--dense', className)} {...rest}>
        {children}
      </table>
    </div>
  );
}

/* --- Key / value list ----------------------------------------------------- */

export interface KeyValueRow {
  key: string;
  value: ReactNode;
}

export function KeyValue({
  rows,
  className,
}: {
  rows: readonly KeyValueRow[];
  className?: string;
}) {
  return (
    <dl className={cx('ui-kv', className)}>
      {rows.map((row) => (
        <div key={row.key} style={{ display: 'contents' }}>
          <dt className="ui-kv__k">{row.key}</dt>
          <dd className="ui-kv__v">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* --- Stat tile ------------------------------------------------------------ */

export interface StatTileProps {
  label: string;
  value: ReactNode;
  unit?: string;
  /** Signed percentage change vs the comparison period. */
  deltaPct?: number | null;
  /** For a delta, whether "up" is bad (congestion) or good (throughput). */
  deltaPolarity?: 'up-is-bad' | 'up-is-good';
  footNote?: ReactNode;
}

export function StatTile({
  label,
  value,
  unit,
  deltaPct,
  deltaPolarity = 'up-is-bad',
  footNote,
}: StatTileProps) {
  let deltaClass = 'ui-stat__delta--flat';
  let deltaText: string | null = null;

  if (deltaPct !== null && deltaPct !== undefined && Number.isFinite(deltaPct)) {
    const rounded = Math.round(deltaPct * 10) / 10;
    deltaText = `${rounded > 0 ? '▲' : rounded < 0 ? '▼' : '■'} ${Math.abs(rounded).toFixed(1)}%`;
    if (rounded !== 0) {
      const isBad = deltaPolarity === 'up-is-bad' ? rounded > 0 : rounded < 0;
      deltaClass = isBad ? 'ui-stat__delta--up' : 'ui-stat__delta--down';
    }
  }

  return (
    <div className="ui-stat">
      <span className="ui-stat__label">{label}</span>
      <span className="ui-stat__value">
        {value}
        {unit ? <span className="ui-stat__unit">{unit}</span> : null}
      </span>
      {deltaText || footNote ? (
        <span className="ui-stat__foot">
          {deltaText ? <span className={deltaClass}>{deltaText}</span> : null}
          {footNote ? <span>{footNote}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

/* --- Legend --------------------------------------------------------------- */

export interface LegendItem {
  color: string;
  label: string;
  /** Render the swatch as a line instead of a square (for link overlays). */
  line?: boolean;
}

export function Legend({
  items,
  className,
}: {
  items: readonly LegendItem[];
  className?: string;
}) {
  return (
    <div className={cx('ui-legend', className)}>
      {items.map((item) => (
        <span className="ui-legend__row" key={item.label}>
          <span
            className={cx('ui-legend__swatch', item.line && 'ui-legend__swatch--line')}
            style={{ background: item.color }}
            aria-hidden="true"
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}
