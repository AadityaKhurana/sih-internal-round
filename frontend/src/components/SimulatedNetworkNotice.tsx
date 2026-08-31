/**
 * The "this network is simulated" disclosure.
 *
 * Non-negotiable on every screen that shows camera positions, plate movements or
 * traffic figures. The cameras are fictional nodes on real roads, fed by
 * prerecorded clips and a synthetic observation generator. Anyone looking at this
 * dashboard — judge, evaluator, or teammate — must not be able to mistake it for
 * a live municipal deployment, and that is a labelling job, not a footnote.
 *
 * Two presentations: `banner` for the top of a page, `inline` for a compact
 * corner note on the map.
 */

import { cx } from '@/lib/cx';
import { InfoIcon } from './icons';
import './simulated-notice.css';

export interface SimulatedNetworkNoticeProps {
  variant?: 'banner' | 'inline';
  /** Extra context for the specific screen, e.g. what the numbers are derived from. */
  detail?: string;
  className?: string;
}

export function SimulatedNetworkNotice({
  variant = 'banner',
  detail,
  className,
}: SimulatedNetworkNoticeProps) {
  if (variant === 'inline') {
    return (
      <div className={cx('sim-notice sim-notice--inline', className)} role="note">
        <InfoIcon size={13} />
        <span>
          <strong>Simulated demo network</strong> — fictional cameras on real roads
        </span>
      </div>
    );
  }

  return (
    <div className={cx('sim-notice sim-notice--banner', className)} role="note">
      <span className="sim-notice__icon" aria-hidden="true">
        <InfoIcon size={15} />
      </span>
      <p className="sim-notice__text">
        <strong>Simulated demo network.</strong> These 12 cameras do not exist. They are
        fictional nodes placed on real road geometry in central Bengaluru, fed by
        prerecorded clips and a synthetic observation generator.
        {detail ? ` ${detail}` : ''}
      </p>
    </div>
  );
}
