/**
 * React Query key factory.
 *
 * Centralised so invalidation is precise: acknowledging an alert should refresh
 * the alert list and its counts without throwing away the map, the camera network
 * or an in-progress analytics query.
 */

import type {
  AlertsQuery,
  AnalyticsWindowQuery,
  BlacklistQuery,
  FlowTrendQuery,
  SightingsQuery,
  TrajectoryQuery,
} from '@/types/api';
import type { ReportGranularity } from '@/types/domain';

export const queryKeys = {
  /** The camera network — effectively static within a session. */
  cameras: () => ['cameras'] as const,
  cameraLinks: () => ['camera-links'] as const,

  plateSearch: (term: string) => ['plate-search', term] as const,
  trajectory: (query: TrajectoryQuery) => ['trajectory', query] as const,
  sightings: (query: SightingsQuery) => ['sightings', query] as const,

  alerts: (query: AlertsQuery) => ['alerts', query] as const,
  alertsRoot: () => ['alerts'] as const,
  alertCounts: (query: AlertsQuery) => ['alert-counts', query] as const,
  alertCountsRoot: () => ['alert-counts'] as const,

  blacklist: (query: BlacklistQuery) => ['blacklist', query] as const,
  blacklistRoot: () => ['blacklist'] as const,

  nodeMetrics: (window: AnalyticsWindowQuery) => ['analytics', 'nodes', window] as const,
  linkCongestion: (window: AnalyticsWindowQuery) => ['analytics', 'links', window] as const,
  flowTrends: (query: FlowTrendQuery) => ['analytics', 'flow-trends', query] as const,
  originDestination: (window: AnalyticsWindowQuery) =>
    ['analytics', 'origin-destination', window] as const,
  analyticsRoot: () => ['analytics'] as const,

  reportPeriods: (granularity: ReportGranularity) =>
    ['reports', 'periods', granularity] as const,
  report: (granularity: ReportGranularity, period: string | undefined) =>
    ['reports', granularity, period ?? 'latest'] as const,
} as const;
