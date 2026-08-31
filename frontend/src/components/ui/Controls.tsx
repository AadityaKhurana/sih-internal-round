import type { InputHTMLAttributes, ReactNode } from 'react';

import { cx } from '@/lib/cx';

/* --- Switch ---------------------------------------------------------------- */

export interface SwitchProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children'> {
  label: ReactNode;
}

export function Switch({ label, className, ...rest }: SwitchProps) {
  return (
    <label className={cx('ui-switch', className)}>
      <input type="checkbox" {...rest} />
      <span className="ui-switch__track" aria-hidden="true">
        <span className="ui-switch__thumb" />
      </span>
      <span>{label}</span>
    </label>
  );
}

/* --- Chip (multi-select filter toggle) ------------------------------------ */

export interface ChipProps {
  pressed: boolean;
  onToggle: () => void;
  count?: number;
  children: ReactNode;
  /** Overrides the chip's active colour, e.g. to match a severity tone. */
  activeColor?: string;
}

export function Chip({ pressed, onToggle, count, children, activeColor }: ChipProps) {
  const style =
    pressed && activeColor
      ? { borderColor: activeColor, color: activeColor }
      : undefined;
  return (
    <button
      type="button"
      className="ui-chip"
      aria-pressed={pressed}
      onClick={onToggle}
      style={style}
    >
      {children}
      {count !== undefined ? <span className="ui-chip__count">{count}</span> : null}
    </button>
  );
}

/* --- Segmented control (single select) ------------------------------------ */

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  title?: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div className={cx('ui-seg', className)} role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className="ui-seg__opt"
          aria-pressed={opt.value === value}
          title={opt.title}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* --- Tabs ----------------------------------------------------------------- */

export interface TabsProps<T extends string> {
  value: T;
  tabs: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
}

export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
  ariaLabel,
}: TabsProps<T>) {
  const activeIndex = tabs.findIndex((t) => t.value === value);

  return (
    <div className="ui-tabs">
      <div className="ui-tabs__list" role="tablist" aria-label={ariaLabel}>
        {tabs.map((tab, index) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            className="ui-tabs__tab"
            aria-selected={tab.value === value}
            tabIndex={tab.value === value ? 0 : -1}
            onClick={() => onChange(tab.value)}
            onKeyDown={(event) => {
              // Roving tabindex: arrows move between tabs, per WAI-ARIA tabs pattern.
              const delta =
                event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
              if (delta === 0) return;
              event.preventDefault();
              const next = tabs[(index + delta + tabs.length) % tabs.length];
              if (next) onChange(next.value);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <span className="u-visually-hidden" aria-live="polite">
        {activeIndex >= 0 ? `${tabs[activeIndex]?.label} tab selected` : ''}
      </span>
    </div>
  );
}
