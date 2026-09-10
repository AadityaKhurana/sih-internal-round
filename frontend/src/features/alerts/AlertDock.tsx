import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAlertCounts, useAlerts } from '@/api/hooks';
import { CloseIcon } from '@/components/icons';
import { Badge, Button, Chip, EmptyState, Loading } from '@/components/ui';
import { useLive } from '@/features/live/LiveProvider';
import { formatPlate } from '@/lib/plate';
import { formatTime } from '@/lib/time';
import type { AlertType } from '@/types/domain';
import type { Alert } from '@/types/domain';
import { AcknowledgeDialog } from './AcknowledgeDialog';
import { AlertCard } from './AlertCard';
import { isOpen } from './alert-format';
import './alerts.css';

type DockFilter = 'open' | 'all' | AlertType;

const FILTERS: ReadonlyArray<{ value: DockFilter; label: string }> = [
  { value: 'open', label: 'Needs action' },
  { value: 'blacklist', label: 'Blacklist' },
  { value: 'route_anomaly', label: 'Anomaly' },
  { value: 'all', label: 'All' },
];

/**
 * The always-present alert dock.
 *
 * It merges two sources: alerts pushed over the live feed this session (which
 * carry the arrival flash) and the most recent alerts fetched from the API. The
 * merge is keyed on `dedup_key`, so an alert that arrives over the socket and then
 * appears in the next fetch is one entry, not two.
 */
export function AlertDock({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { liveAlerts, reconnectCount } = useLive();
  const [filter, setFilter] = useState<DockFilter>('open');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ackTarget, setAckTarget] = useState<Alert | null>(null);

  const { data, isLoading, isError } = useAlerts({ limit: 40 });
  const { data: counts } = useAlertCounts({});

  // Keys of alerts delivered live, so only those flash on render.
  const liveKeys = useMemo(
    () => new Set(liveAlerts.map((alert) => alert.dedup_key)),
    [liveAlerts],
  );

  const merged = useMemo(() => {
    const seen = new Set<string>();
    const out: Alert[] = [];
    // Live first: they are the newest and carry the freshest status.
    for (const alert of [...liveAlerts, ...(data?.items ?? [])]) {
      if (seen.has(alert.dedup_key)) continue;
      seen.add(alert.dedup_key);
      out.push(alert);
    }
    return out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }, [liveAlerts, data?.items]);

  const visible = useMemo(() => {
    switch (filter) {
      case 'open':
        return merged.filter(isOpen);
      case 'blacklist':
        return merged.filter((alert) => alert.alert_type === 'blacklist');
      case 'route_anomaly':
        return merged.filter((alert) => alert.alert_type === 'route_anomaly');
      default:
        return merged;
    }
  }, [merged, filter]);

  const countFor = (value: DockFilter): number | undefined => {
    if (!counts) return undefined;
    switch (value) {
      case 'open':
        return counts.new + (counts.total - counts.new - counts.acknowledged - counts.resolved);
      case 'blacklist':
        return counts.blacklist;
      case 'route_anomaly':
        return counts.route_anomaly;
      default:
        return counts.total;
    }
  };

  return (
    <div className="dock">
      <div className="dock__head">
        <div className="dock__title-row">
          <h2 className="dock__title">Alert feed</h2>
          {counts && counts.new > 0 ? (
            <Badge tone="danger" dot pulse>
              {counts.new} new
            </Badge>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Hide the alert dock"
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </Button>
        </div>

        <div className="dock__filters">
          {FILTERS.map((option) => (
            <Chip
              key={option.value}
              pressed={filter === option.value}
              onToggle={() => setFilter(option.value)}
              {...(countFor(option.value) !== undefined
                ? { count: countFor(option.value) }
                : {})}
            >
              {option.label}
            </Chip>
          ))}
        </div>

        {reconnectCount > 0 ? (
          <p className="dock__gap-note">
            Feed reconnected {reconnectCount}×. Alerts were refetched, but frames
            dropped while disconnected are not replayed.
          </p>
        ) : null}
      </div>

      <div className="dock__body">
        {isLoading && merged.length === 0 ? <Loading label="Loading alerts…" /> : null}

        {isError && merged.length === 0 ? (
          <EmptyState
            tone="error"
            icon="⚠"
            title="Alert feed unavailable"
            body="Could not reach the alerts endpoint. The live socket may still deliver new alerts."
          />
        ) : null}

        {!isLoading && visible.length === 0 ? (
          <EmptyState
            icon="✓"
            title={filter === 'open' ? 'Nothing needs action' : 'No alerts match'}
            body={
              filter === 'open'
                ? 'Every alert in the current window has been acknowledged or resolved.'
                : 'Try a different filter.'
            }
          />
        ) : null}

        {visible.map((alert) => (
          <AlertCard
            key={alert.alert_id}
            alert={alert}
            compact
            fresh={liveKeys.has(alert.dedup_key)}
            selected={selectedId === alert.alert_id}
            onSelect={(next) =>
              setSelectedId((current) =>
                current === next.alert_id ? null : next.alert_id,
              )
            }
            onAcknowledge={setAckTarget}
            onShowTrajectory={(plate) =>
              navigate(`/trajectory?plate=${encodeURIComponent(plate)}`)
            }
            onLocate={(next) =>
              navigate(`/map?camera=${encodeURIComponent(next.camera_code)}`)
            }
          />
        ))}
      </div>

      <LiveTickerStrip />

      <div className="dock__foot">
        <span>
          Showing {visible.length} of {merged.length} recent
        </span>
        <Link to="/alerts">Open full list →</Link>
      </div>

      <AcknowledgeDialog alert={ackTarget} onClose={() => setAckTarget(null)} />
    </div>
  );
}

/**
 * Compact live sighting ticker at the foot of the dock. Gives the feed a visible
 * pulse so a quiet alert list doesn't read as a broken connection.
 */
function LiveTickerStrip() {
  const { liveSightings } = useLive();
  if (liveSightings.length === 0) return null;

  return (
    <div
      style={{
        flex: '0 0 auto',
        borderTop: '1px solid var(--c-border)',
        padding: 'var(--sp-2)',
      }}
    >
      <div className="u-row-between" style={{ marginBottom: 'var(--sp-1)' }}>
        <span className="u-label">Live sightings</span>
        <span className="u-dim" style={{ fontSize: 'var(--fs-2xs)' }}>
          last {liveSightings.length}
        </span>
      </div>
      <div className="ticker" aria-live="off">
        {liveSightings.slice(0, 6).map((sighting, index) => (
          <div
            key={sighting.sighting_id}
            className={index === 0 ? 'ticker__row is-fresh' : 'ticker__row'}
          >
            <span className="ticker__time">{formatTime(sighting.spotted_at)}</span>
            <span className="ticker__plate u-truncate">
              {formatPlate(sighting.normalized_plate)}
            </span>
            <span className="ticker__camera">{sighting.camera_code}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
