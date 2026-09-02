import type { ReactNode } from 'react';

import { cx } from '@/lib/cx';

/** A floating panel over the map canvas. Chrome only — no map awareness. */
export function MapPanel({
  title,
  actions,
  children,
  tight = false,
  className,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  tight?: boolean;
  className?: string;
}) {
  return (
    <div className={cx('map-panel', className)}>
      {title || actions ? (
        <div className="map-panel__head">
          {title ? <span className="map-panel__title">{title}</span> : null}
          {actions}
        </div>
      ) : null}
      <div className={cx('map-panel__body', tight && 'map-panel__body--tight')}>
        {children}
      </div>
    </div>
  );
}
