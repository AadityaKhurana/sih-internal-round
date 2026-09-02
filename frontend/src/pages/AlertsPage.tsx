import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAlertCounts, useAlerts, useCameras } from '@/api/hooks';
import { BellIcon } from '@/components/icons';
import { SimulatedNetworkNotice } from '@/components/SimulatedNetworkNotice';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  StatTile,
} from '@/components/ui';
import { AcknowledgeDialog } from '@/features/alerts/AcknowledgeDialog';
import { AlertCard } from '@/features/alerts/AlertCard';
import { AlertDetail } from '@/features/alerts/AlertDetail';
import { AlertFilters } from '@/features/alerts/AlertFilters';
import { useLive } from '@/features/live/LiveProvider';
import { formatCount } from '@/lib/congestion';
import type { AlertsQuery } from '@/types/api';
import type { Alert } from '@/types/domain';
import '@/features/alerts/alerts.css';

const PAGE_SIZE = 25;

/**
 * The full alert list: filter, triage, acknowledge.
 *
 * The dock in the shell is for "what just happened"; this page is for working
 * through a backlog. Alerts delivered over the live feed are merged into the list
 * on `dedup_key` so a socket delivery and the next fetch never show up twice.
 */
export function AlertsPage() {
  const navigate = useNavigate();
  const { liveAlerts } = useLive();

  const [query, setQuery] = useState<AlertsQuery>({ limit: PAGE_SIZE, offset: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ackTarget, setAckTarget] = useState<Alert | null>(null);

  const cameras = useCameras();
  const alerts = useAlerts(query);
  const counts = useAlertCounts({
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
  });

  const liveKeys = useMemo(
    () => new Set(liveAlerts.map((alert) => alert.dedup_key)),
    [liveAlerts],
  );

  const items = alerts.data?.items ?? [];
  const total = alerts.data?.total ?? 0;
  const offset = query.offset ?? 0;

  const selected = useMemo(
    () => items.find((alert) => alert.alert_id === selectedId) ?? null,
    [items, selectedId],
  );

  const cameraCodes = useMemo(
    () =>
      (cameras.data?.features ?? [])
        .map((feature) => feature.properties.camera_code)
        .sort(),
    [cameras.data],
  );

  const locate = (alert: Alert) =>
    navigate(`/map?camera=${encodeURIComponent(alert.camera_code)}`);

  return (
    <div className="page">
      <SimulatedNetworkNotice detail="Alerts below were raised against generated observations." />

      <div className="page__grid page__grid--stats">
        <StatTile
          label="Alerts in window"
          value={formatCount(counts.data?.total)}
          footNote={query.from ? 'filtered window' : 'all time'}
        />
        <StatTile
          label="Awaiting action"
          value={formatCount((counts.data?.new ?? 0) + 0)}
          footNote="status = new"
        />
        <StatTile
          label="Blacklist hits"
          value={formatCount(counts.data?.blacklist)}
          footNote="matched an active entry"
        />
        <StatTile
          label="Route anomalies"
          value={formatCount(counts.data?.route_anomaly)}
          footNote="independent of the blacklist"
        />
        <StatTile
          label="Acknowledged"
          value={formatCount(
            (counts.data?.acknowledged ?? 0) + (counts.data?.resolved ?? 0),
          )}
          deltaPolarity="up-is-good"
          footNote="incl. resolved"
        />
      </div>

      <Card title="Filters" subtitle="Counts show what each filter would return in this window">
        <AlertFilters
          query={query}
          counts={counts.data}
          cameraCodes={cameraCodes}
          onChange={setQuery}
        />
      </Card>

      <div className="alerts-page__layout">
        <Card
          title="Alerts"
          subtitle={
            total > 0
              ? `${offset + 1}–${Math.min(offset + items.length, total)} of ${total}`
              : undefined
          }
          actions={
            <>
              <Button
                size="sm"
                disabled={offset === 0}
                onClick={() =>
                  setQuery((current) => ({
                    ...current,
                    offset: Math.max(0, (current.offset ?? 0) - PAGE_SIZE),
                  }))
                }
              >
                Previous
              </Button>
              <Button
                size="sm"
                disabled={offset + items.length >= total}
                onClick={() =>
                  setQuery((current) => ({
                    ...current,
                    offset: (current.offset ?? 0) + PAGE_SIZE,
                  }))
                }
              >
                Next
              </Button>
            </>
          }
        >
          {alerts.isLoading ? <Loading label="Loading alerts…" /> : null}

          {alerts.isError ? (
            <ErrorState error={alerts.error} onRetry={() => void alerts.refetch()} />
          ) : null}

          {!alerts.isLoading && items.length === 0 ? (
            <EmptyState
              icon={<BellIcon size={24} />}
              title="No alerts match these filters"
              body="Widen the window or clear a filter chip."
              action={
                <Button
                  size="sm"
                  onClick={() => setQuery({ limit: PAGE_SIZE, offset: 0 })}
                >
                  Clear filters
                </Button>
              }
            />
          ) : null}

          <div className="u-col" style={{ gap: 'var(--sp-2)' }}>
            {items.map((alert) => (
              <AlertCard
                key={alert.alert_id}
                alert={alert}
                selected={selectedId === alert.alert_id}
                fresh={liveKeys.has(alert.dedup_key)}
                onSelect={(next) => setSelectedId(next.alert_id)}
                onAcknowledge={setAckTarget}
                onShowTrajectory={(plate) =>
                  navigate(`/trajectory?plate=${encodeURIComponent(plate)}`)
                }
                onLocate={locate}
              />
            ))}
          </div>
        </Card>

        <div>
          {selected ? (
            <AlertDetail alert={selected} onAcknowledge={setAckTarget} onLocate={locate} />
          ) : (
            <Card title="Alert detail">
              <EmptyState
                icon="◎"
                title="No alert selected"
                body="Pick an alert to see the evidence behind it, the sightings involved, and the acknowledgement trail."
              />
            </Card>
          )}

          {liveAlerts.length > 0 ? (
            <Card
              title="Delivered live this session"
              subtitle="Pushed over the feed since this page loaded"
              style={{ marginTop: 'var(--sp-4)' }}
              actions={<Badge tone="violet">{liveAlerts.length}</Badge>}
            >
              <div className="u-col" style={{ gap: 'var(--sp-2)' }}>
                {liveAlerts.slice(0, 4).map((alert) => (
                  <AlertCard
                    key={alert.alert_id}
                    alert={alert}
                    compact
                    fresh
                    onSelect={(next) => setSelectedId(next.alert_id)}
                  />
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      </div>

      <AcknowledgeDialog
        alert={ackTarget}
        onClose={() => setAckTarget(null)}
        onDone={(updated) => setSelectedId(updated.alert_id)}
      />
    </div>
  );
}
