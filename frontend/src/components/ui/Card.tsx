import type { HTMLAttributes, ReactNode } from 'react';

import { cx } from '@/lib/cx';

// `title` is widened from the DOM's `string` to `ReactNode` so a card heading can
// carry badges and counts, not just text.
export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Remove body padding — for tables and maps that bleed to the edge. */
  flush?: boolean;
  /** Stretch to the parent's height and scroll the body. */
  fill?: boolean;
  bodyClassName?: string;
  children?: ReactNode;
}

export function Card({
  title,
  subtitle,
  actions,
  footer,
  flush = false,
  fill = false,
  className,
  bodyClassName,
  children,
  ...rest
}: CardProps) {
  return (
    <section className={cx('ui-card', fill && 'ui-card--fill', className)} {...rest}>
      {title || actions ? (
        <header className="ui-card__head">
          <div className="ui-card__titles">
            {title ? <h2 className="ui-card__title">{title}</h2> : null}
            {subtitle ? <p className="ui-card__sub">{subtitle}</p> : null}
          </div>
          {actions ? <div className="ui-card__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div
        className={cx('ui-card__body', flush && 'ui-card__body--flush', bodyClassName)}
      >
        {children}
      </div>
      {footer ? <footer className="ui-card__foot">{footer}</footer> : null}
    </section>
  );
}
