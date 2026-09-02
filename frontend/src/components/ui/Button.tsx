import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cx } from '@/lib/cx';

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';
export type ButtonSize = 'xs' | 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Square icon-only button. Always pass `aria-label` with this. */
  iconOnly?: boolean;
  block?: boolean;
  active?: boolean;
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = 'default',
  size = 'md',
  iconOnly = false,
  block = false,
  active = false,
  loading = false,
  className,
  disabled,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'ui-btn',
        variant !== 'default' && `ui-btn--${variant}`,
        size !== 'md' && `ui-btn--${size}`,
        iconOnly && 'ui-btn--icon',
        block && 'ui-btn--block',
        active && 'is-active',
        className,
      )}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="ui-spinner" style={{ width: 12, height: 12 }} /> : null}
      {children}
    </button>
  );
}
