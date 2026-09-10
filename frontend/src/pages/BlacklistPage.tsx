import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { useBlacklist, useUpdateBlacklistEntry } from '@/api/hooks';
import { PlusIcon, ShieldIcon } from '@/components/icons';
import { SimulatedNetworkNotice } from '@/components/SimulatedNetworkNotice';
import {
  Badge,
  Button,
  Card,
  Chip,
  DataTable,
  EmptyState,
  ErrorState,
  Loading,
  StatTile,
  TextInput,
} from '@/components/ui';
import { BlacklistDialog } from '@/features/blacklist/BlacklistDialog';
import { SEVERITY_HEX, SEVERITY_RANK, SEVERITY_TONE, formatCount } from '@/lib/congestion';
import { formatPlate } from '@/lib/plate';
import { formatDateTime, formatRelative } from '@/lib/time';
import type { BlacklistQuery } from '@/types/api';
import {
  BLACKLIST_STATUSES,
  SEVERITIES,
  type BlacklistEntry,
  type BlacklistStatus,
  type Severity,
} from '@/types/domain';

const STATUS_TONE: Record<BlacklistStatus, 'ok' | 'neutral' | 'warn'> = {
  active: 'ok',
  inactive: 'neutral',
  expired: 'warn',
};

/**
 * Blacklist management.
 *
 * An entry is what turns a sighting into an alert, so this page treats the
 * enforcement *window* as first-class: an entry can be active, deactivated by an
 * operator, or expired by its own end date, and those three are visually distinct
 * because only the first will raise alerts. Entries are deactivated rather than
 * deleted — the alerts they already raised must stay explainable.
 */
export function BlacklistPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState<BlacklistQuery>({ limit: 100, offset: 0 });
  const [search, setSearch] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);

  const prefillPlate = searchParams.get('plate') ?? '';

  const blacklist = useBlacklist(useMemo(() => ({ ...query, q: search || undefined }), [query, search]));
  const update = useUpdateBlacklistEntry();

  const entries = blacklist.data?.items ?? [];

  const stats = useMemo(() => {
    const all = entries;
    return {
      active: all.filter((entry) => entry.status === 'active').length,
      critical: all.filter(
        (entry) => entry.status === 'active' && entry.severity === 'critical',
      ).length,
      seen: all.filter((entry) => (entry.sighting_count ?? 0) > 0).length,
      total: blacklist.data?.total ?? 0,
    };
  }, [entries, blacklist.data]);

  const sorted = useMemo(
    () =>
      [...entries].sort((a, b) => {
        // Enforceable entries first, then by severity, then most recent.
        const aActive = a.status === 'active' ? 0 : 1;
        const bActive = b.status === 'active' ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        const rank = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
        if (rank !== 0) return rank;
        return Date.parse(b.active_from) - Date.parse(a.active_from);
      }),
    [entries],
  );

  function toggleFilter<T extends string>(
    key: 'status' | 'severity',
    value: T,
    current: readonly T[] | undefined,
  ): void {
    const set = new Set(current ?? []);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    const next = [...set];
    setQuery({ ...query, [key]: next.length > 0 ? next : undefined, offset: 0 });
  }

  const setStatus = (entry: BlacklistEntry, status: BlacklistStatus) => {
    update.mutate({ entryId: entry.blacklist_entry_id, body: { status } });
  };

  return (
    <div className="page">
      <SimulatedNetworkNotice detail="These are demo watch-list records against fictional vehicles." />

      <div className="page__grid page__grid--stats">
        <StatTile label="Entries" value={formatCount(stats.total)} footNote="all statuses" />
        <StatTile
          label="Enforceable now"
          value={formatCount(stats.active)}
          footNote="active and within their window"
        />
        <StatTile
          label="Critical"
          value={formatCount(stats.critical)}
          footNote="active, highest severity"
        />
        <StatTile
          label="Seen by the network"
          value={formatCount(stats.seen)}
          footNote="have at least one sighting"
        />
      </div>

      <Card
        title="Watch list"
        subtitle="An entry only raises alerts while it is active and inside its window"
        actions={
          <Button
            size="sm"
            variant="primary"
            onClick={() => setDialogOpen(true)}
          >
            <PlusIcon size={13} /> Add entry
          </Button>
        }
        flush
      >
        <div
          className="u-col"
          style={{ gap: 'var(--sp-3)', padding: 'var(--sp-4)', paddingBottom: 'var(--sp-3)' }}
        >
          <div className="u-row u-wrap" style={{ gap: 'var(--sp-2)' }}>
            <span className="u-label" style={{ minWidth: '4.5rem' }}>
              Status
            </span>
            {BLACKLIST_STATUSES.map((status) => (
              <Chip
                key={status}
                pressed={query.status?.includes(status) ?? false}
                onToggle={() => toggleFilter<BlacklistStatus>('status', status, query.status)}
              >
                {status}
              </Chip>
            ))}
          </div>

          <div className="u-row u-wrap" style={{ gap: 'var(--sp-2)' }}>
            <span className="u-label" style={{ minWidth: '4.5rem' }}>
              Severity
            </span>
            {SEVERITIES.map((severity) => (
              <Chip
                key={severity}
                pressed={query.severity?.includes(severity) ?? false}
                onToggle={() => toggleFilter<Severity>('severity', severity, query.severity)}
                activeColor={SEVERITY_HEX[severity]}
              >
                {severity}
              </Chip>
            ))}
          </div>

          <TextInput
            label="Search"
            small
            mono
            placeholder="Plate or case reference"
            value={search}
            onChange={(event) => setSearch(event.target.value.toUpperCase())}
            hint="Matches a normalised plate or a case reference."
          />
        </div>

        {blacklist.isLoading ? (
          <Loading />
        ) : blacklist.isError ? (
          <ErrorState error={blacklist.error} onRetry={() => void blacklist.refetch()} />
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={<ShieldIcon size={24} />}
            title="No entries match"
            body="Clear a filter, or add the first entry for this plate."
          />
        ) : (
          <DataTable>
            <thead>
              <tr>
                <th scope="col">Plate</th>
                <th scope="col">Severity</th>
                <th scope="col">Status</th>
                <th scope="col">Reason</th>
                <th scope="col">Window</th>
                <th scope="col" className="is-num">
                  Sightings
                </th>
                <th scope="col">Added by</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry) => (
                <tr key={entry.blacklist_entry_id}>
                  <td>
                    <Link
                      to={`/trajectory?plate=${encodeURIComponent(entry.normalized_plate)}`}
                      className="u-num"
                    >
                      {formatPlate(entry.normalized_plate)}
                    </Link>
                    {entry.case_reference ? (
                      <>
                        <br />
                        <span className="u-dim" style={{ fontSize: 'var(--fs-2xs)' }}>
                          {entry.case_reference}
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    <Badge tone={SEVERITY_TONE[entry.severity]}>{entry.severity}</Badge>
                  </td>
                  <td>
                    <Badge tone={STATUS_TONE[entry.status]}>{entry.status}</Badge>
                  </td>
                  <td style={{ maxWidth: 280 }}>
                    <span style={{ fontSize: 'var(--fs-xs)' }}>{entry.reason}</span>
                  </td>
                  <td style={{ fontSize: 'var(--fs-2xs)' }} className="u-dim">
                    from {formatDateTime(entry.active_from)}
                    <br />
                    {entry.active_until
                      ? `until ${formatDateTime(entry.active_until)}`
                      : 'open-ended'}
                  </td>
                  <td className="is-num">
                    {formatCount(entry.sighting_count ?? 0)}
                    {entry.last_seen_at ? (
                      <>
                        <br />
                        <span className="u-dim" style={{ fontSize: 'var(--fs-2xs)' }}>
                          {formatRelative(entry.last_seen_at)}
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td className="u-num" style={{ fontSize: 'var(--fs-2xs)' }}>
                    {entry.added_by ?? '—'}
                  </td>
                  <td>
                    {entry.status === 'active' ? (
                      <Button
                        size="xs"
                        variant="danger"
                        loading={
                          update.isPending &&
                          update.variables?.entryId === entry.blacklist_entry_id
                        }
                        onClick={() => setStatus(entry, 'inactive')}
                      >
                        Deactivate
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        loading={
                          update.isPending &&
                          update.variables?.entryId === entry.blacklist_entry_id
                        }
                        onClick={() => setStatus(entry, 'active')}
                      >
                        Reactivate
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>

      <p className="ui-field__hint">
        Entries are deactivated, never deleted: alerts already raised reference the
        entry that caused them, and removing it would leave those alerts
        unexplainable. An expired entry stops matching on its own end date.
      </p>

      <BlacklistDialog
        open={dialogOpen}
        initialPlate={prefillPlate}
        onClose={() => {
          setDialogOpen(false);
          if (prefillPlate) setSearchParams({}, { replace: true });
        }}
      />
    </div>
  );
}
