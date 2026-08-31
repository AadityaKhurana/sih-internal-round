/**
 * React Query bindings. Components use these, never `apiClient` directly, so
 * caching, retry and invalidation policy lives in one place.
 *
 * Staleness is tuned per resource: the camera network barely changes, alerts and
 * live metrics change constantly, and reports are expensive enough to keep.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AcknowledgeAlertRequest,
  AlertsQuery,
  AnalyticsWindowQuery,
  BlacklistQuery,
  CreateBlacklistEntryRequest,
  FlowTrendQuery,
  SightingsQuery,
  TrajectoryQuery,
  UpdateBlacklistEntryRequest,
} from '@/types/api';
import type { ReportGranularity } from '@/types/domain';
import { apiClient } from './client';
import { queryKeys } from './queryKeys';

const MINUTE = 60_000;

/* ----------------------------------------------------------------- network -- */

export function useCameras() {
  return useQuery({
    queryKey: queryKeys.cameras(),
    queryFn: () => apiClient.getCameras(),
    staleTime: 10 * MINUTE,
  });
}

export function useCameraLinks() {
  return useQuery({
    queryKey: queryKeys.cameraLinks(),
    queryFn: () => apiClient.getCameraLinks(),
    staleTime: 10 * MINUTE,
  });
}

/* ------------------------------------------------------------ plate lookups -- */

export function usePlateSearch(term: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.plateSearch(term),
    queryFn: () => apiClient.searchPlates(term),
    enabled: enabled && term.trim().length >= 2,
    staleTime: 30_000,
  });
}

export function useTrajectory(query: TrajectoryQuery | null) {
  return useQuery({
    queryKey: queryKeys.trajectory(query ?? { plate: '' }),
    queryFn: () => apiClient.getTrajectory(query!),
    enabled: query !== null && query.plate.trim().length > 0,
    staleTime: MINUTE,
  });
}

export function useSightings(query: SightingsQuery, enabled = true) {
  return useQuery({
    queryKey: queryKeys.sightings(query),
    queryFn: () => apiClient.getSightings(query),
    enabled,
    staleTime: 30_000,
  });
}

/* ------------------------------------------------------------------ alerts -- */

export function useAlerts(query: AlertsQuery) {
  return useQuery({
    queryKey: queryKeys.alerts(query),
    queryFn: () => apiClient.getAlerts(query),
    staleTime: 15_000,
  });
}

export function useAlertCounts(query: AlertsQuery) {
  return useQuery({
    queryKey: queryKeys.alertCounts(query),
    queryFn: () => apiClient.getAlertCounts(query),
    staleTime: 15_000,
  });
}

export function useAcknowledgeAlert() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      alertId,
      body,
    }: {
      alertId: string;
      body: AcknowledgeAlertRequest;
    }) => apiClient.acknowledgeAlert(alertId, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.alertsRoot() });
      void client.invalidateQueries({ queryKey: queryKeys.alertCountsRoot() });
    },
  });
}

/* --------------------------------------------------------------- blacklist -- */

export function useBlacklist(query: BlacklistQuery) {
  return useQuery({
    queryKey: queryKeys.blacklist(query),
    queryFn: () => apiClient.getBlacklist(query),
    staleTime: 30_000,
  });
}

export function useCreateBlacklistEntry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateBlacklistEntryRequest) =>
      apiClient.createBlacklistEntry(body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.blacklistRoot() });
      // A new entry changes which future sightings raise alerts.
      void client.invalidateQueries({ queryKey: queryKeys.alertCountsRoot() });
    },
  });
}

export function useUpdateBlacklistEntry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      entryId,
      body,
    }: {
      entryId: string;
      body: UpdateBlacklistEntryRequest;
    }) => apiClient.updateBlacklistEntry(entryId, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.blacklistRoot() });
    },
  });
}

/* --------------------------------------------------------------- analytics -- */

export function useNodeMetrics(window: AnalyticsWindowQuery, enabled = true) {
  return useQuery({
    queryKey: queryKeys.nodeMetrics(window),
    queryFn: () => apiClient.getNodeMetrics(window),
    enabled,
    staleTime: MINUTE,
  });
}

export function useLinkCongestion(window: AnalyticsWindowQuery, enabled = true) {
  return useQuery({
    queryKey: queryKeys.linkCongestion(window),
    queryFn: () => apiClient.getLinkCongestion(window),
    enabled,
    staleTime: MINUTE,
  });
}

export function useFlowTrends(query: FlowTrendQuery, enabled = true) {
  return useQuery({
    queryKey: queryKeys.flowTrends(query),
    queryFn: () => apiClient.getFlowTrends(query),
    enabled,
    staleTime: MINUTE,
  });
}

export function useOriginDestination(window: AnalyticsWindowQuery, enabled = true) {
  return useQuery({
    queryKey: queryKeys.originDestination(window),
    queryFn: () => apiClient.getOriginDestination(window),
    enabled,
    staleTime: 2 * MINUTE,
  });
}

/* ----------------------------------------------------------------- reports -- */

export function useReportPeriods(granularity: ReportGranularity) {
  return useQuery({
    queryKey: queryKeys.reportPeriods(granularity),
    queryFn: () => apiClient.getReportPeriods(granularity),
    staleTime: 30 * MINUTE,
  });
}

export function useReport(granularity: ReportGranularity, period: string | undefined) {
  return useQuery({
    queryKey: queryKeys.report(granularity, period),
    queryFn: () => apiClient.getReport(granularity, period),
    // Reports aggregate a whole week or month; hold them for the session.
    staleTime: 30 * MINUTE,
  });
}
