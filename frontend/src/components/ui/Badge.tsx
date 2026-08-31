import type { HTMLAttributes, ReactNode } from 'react';

import { cx } from '@/lib/cx';

export type BadgeTone =
  | 'neutral'
  | 'info'
  | 'ok'
  | 'warn'
  | 'danger'
  | 'critical'
  | 'violet'
  | 'accent';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  dot?: boolean;
  pulse?: boolean;
  children?: ReactNode;
}

export function Badge({
  tone = 'neutral',
  dot = false,
  pulse = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span className={cx('ui-badge', `ui-badge--${tone}`, className)} {...rest}>
      {dot ? (
        <span
          className={cx('ui-badge__dot', pulse && 'ui-badge__dot--pulse')}
          aria-hidden="true"
        />
      ) : null}
      {children}
    </span>
  );
}
