/**
 * Mock transport: satisfies `ApiClient` from the in-memory fixtures.
 *
 * It deliberately behaves like a network, not a function call:
 *  - responses are asynchronous with a small variable delay, so loading states,
 *    skeletons and race conditions are actually exercised in development;
 *  - failures surface as `ApiError` with the status the real endpoint would use,
 *    so error handling is not written against a happy path that always holds;
 *  - heavier endpoints (monthly reports) are given a longer delay, because those
 *    are the ones where a missing spinner would be noticed in a demo.
 */

import type {
  AcknowledgeAlertRequest,
  AlertCounts,
  AlertsQuery,
  AnalyticsWindowQuery,
  BlacklistQuery,
  CameraLinksResponse,
  CamerasResponse,
  CreateBlacklistEntryRequest,
  FlowTrendQuery,
  FlowTrendResponse,
  LinkCongestionResponse,
  NodeMetricsResponse,
  OriginDestinationResponse,
  Paginated,
  PlateSuggestion,
  ReportListResponse,
  SightingsQuery,
  TrajectoryQuery,
  TrajectoryResponse,
  UpdateBlacklistEntryRequest,
} from '@/types/api';
import type {
  Alert,
  BlacklistEntry,
  CongestionReport,
  ReportGranularity,
  Sighting,
} from '@/types/domain';
import type { ApiClient } from '../client';
import { ApiError } from '../errors';
import * as queries from './queries';

/** Simulated round-trip time, in ms. */
const LATENCY = { fast: [40, 110], normal: [90, 220], slow: [260, 520] } as const;

type LatencyProfile = keyof typeof LATENCY;

function delay(profile: LatencyProfile): Promise<void> {
  const [min, max] = LATENCY[profile];
  const ms = min + Math.random() * (max - min);
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Run a query behind a simulated network hop, translating the query engine's
 * errors into the `ApiError` the rest of the app already handles.
 */
async function respond<T>(profile: LatencyProfile, work: () => T): Promise<T> {
  await delay(profile);
  try {
    return work();
  } catch (error) {
    if (error instanceof queries.MockApiError) {
      throw new ApiError(error.status, error.message);
    }
    throw new ApiError(
      500,
      error instanceof Error ? error.message : 'Mock transport failure',
    );
  }
}

export const mockClient: ApiClient = {
  getCameras: (): Promise<CamerasResponse> => respond('fast', queries.getCameras),
  getCameraLinks: (): Promise<CameraLinksResponse> =>
    respond('fast', queries.getCameraLinks),

  searchPlates: (query: string, limit?: number): Promise<PlateSuggestion[]> =>
    respond('fast', () => queries.searchPlates(query, limit)),

  getTrajectory: (query: TrajectoryQuery): Promise<TrajectoryResponse> =>
    respond('normal', () => queries.getTrajectory(query)),

  getSightings: (query: SightingsQuery): Promise<Paginated<Sighting>> =>
    respond('normal', () => queries.getSightings(query)),

  getAlerts: (query: AlertsQuery): Promise<Paginated<Alert>> =>
    respond('fast', () => queries.getAlerts(query)),

  getAlertCounts: (query: AlertsQuery): Promise<AlertCounts> =>
    respond('fast', () => queries.getAlertCounts(query)),

  acknowledgeAlert: (alertId: string, body: AcknowledgeAlertRequest): Promise<Alert> =>
    respond('normal', () => queries.acknowledgeAlert(alertId, body)),

  getBlacklist: (query: BlacklistQuery): Promise<Paginated<BlacklistEntry>> =>
    respond('fast', () => queries.getBlacklist(query)),

  createBlacklistEntry: (body: CreateBlacklistEntryRequest): Promise<BlacklistEntry> =>
    respond('normal', () => queries.createBlacklistEntry(body)),

  updateBlacklistEntry: (
    entryId: string,
    body: UpdateBlacklistEntryRequest,
  ): Promise<BlacklistEntry> =>
    respond('normal', () => queries.updateBlacklistEntry(entryId, body)),

  getNodeMetrics: (query: AnalyticsWindowQuery): Promise<NodeMetricsResponse> =>
    respond('normal', () => queries.getNodeMetrics(query)),

  getLinkCongestion: (query: AnalyticsWindowQuery): Promise<LinkCongestionResponse> =>
    respond('normal', () => queries.getLinkCongestion(query)),

  getFlowTrends: (query: FlowTrendQuery): Promise<FlowTrendResponse> =>
    respond('normal', () => queries.getFlowTrends(query)),

  getOriginDestination: (
    query: AnalyticsWindowQuery,
  ): Promise<OriginDestinationResponse> =>
    respond('normal', () => queries.getOriginDestination(query)),

  getReportPeriods: (granularity: ReportGranularity): Promise<ReportListResponse> =>
    respond('fast', () => queries.getReportPeriods(granularity)),

  getReport: (granularity: ReportGranularity, period?: string): Promise<CongestionReport> =>
    respond('slow', () => queries.getReport(granularity, period)),
};
