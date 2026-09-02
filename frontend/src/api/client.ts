/**
 * The single interface every screen talks to, plus the real HTTP implementation.
 *
 * `apiClient` is resolved once from `USE_MOCK`. Nothing above this file knows
 * which transport is in play.
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
import { API_BASE_URL, OPERATOR_HEADER, USE_MOCK } from './config';
import { ApiError } from './errors';
import { getOperatorSubject } from './operator';

export interface ApiClient {
  getCameras(): Promise<CamerasResponse>;
  getCameraLinks(): Promise<CameraLinksResponse>;

  searchPlates(query: string, limit?: number): Promise<PlateSuggestion[]>;
  getTrajectory(query: TrajectoryQuery): Promise<TrajectoryResponse>;
  getSightings(query: SightingsQuery): Promise<Paginated<Sighting>>;

  getAlerts(query: AlertsQuery): Promise<Paginated<Alert>>;
  getAlertCounts(query: AlertsQuery): Promise<AlertCounts>;
  acknowledgeAlert(alertId: string, body: AcknowledgeAlertRequest): Promise<Alert>;

  getBlacklist(query: BlacklistQuery): Promise<Paginated<BlacklistEntry>>;
  createBlacklistEntry(body: CreateBlacklistEntryRequest): Promise<BlacklistEntry>;
  updateBlacklistEntry(
    entryId: string,
    body: UpdateBlacklistEntryRequest,
  ): Promise<BlacklistEntry>;

  getNodeMetrics(query: AnalyticsWindowQuery): Promise<NodeMetricsResponse>;
  getLinkCongestion(query: AnalyticsWindowQuery): Promise<LinkCongestionResponse>;
  getFlowTrends(query: FlowTrendQuery): Promise<FlowTrendResponse>;
  getOriginDestination(query: AnalyticsWindowQuery): Promise<OriginDestinationResponse>;

  getReportPeriods(granularity: ReportGranularity): Promise<ReportListResponse>;
  getReport(granularity: ReportGranularity, period?: string): Promise<CongestionReport>;
}

export { ApiError };

/* --------------------------------------------------------------- query util -- */

type QueryValue = string | number | boolean | undefined | null | readonly string[];

/**
 * Build a query string. Arrays become repeated keys (`?status=new&status=delivered`),
 * which is what FastAPI expects for a `list[str]` dependency.
 */
export function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item);
    } else {
      search.append(key, String(value));
    }
  }
  const text = search.toString();
  return text.length > 0 ? `?${text}` : '';
}

/* ------------------------------------------------------------ http transport -- */

/** `body` is widened to any JSON-serialisable value, not just `BodyInit`. */
type JsonRequestInit = Omit<RequestInit, 'body'> & { body?: unknown };

async function request<T>(path: string, init?: JsonRequestInit): Promise<T> {
  const { body, ...rest } = init ?? {};

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      // Placeholder identity until auth exists — see api/operator.ts.
      [OPERATOR_HEADER]: getOperatorSubject(),
      ...rest.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    let code: string | undefined;
    try {
      const parsed = (await response.json()) as { detail?: string; code?: string };
      if (parsed.detail) detail = parsed.detail;
      code = parsed.code;
    } catch {
      // Non-JSON error body; keep the status line as the message.
    }
    throw new ApiError(response.status, detail, code);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const httpClient: ApiClient = {
  getCameras: () => request<CamerasResponse>('/cameras'),
  getCameraLinks: () => request<CameraLinksResponse>('/camera-links'),

  searchPlates: (query, limit) =>
    request<PlateSuggestion[]>(`/plates/search${buildQuery({ q: query, limit })}`),

  getTrajectory: (query) =>
    request<TrajectoryResponse>(
      `/plates/${encodeURIComponent(query.plate)}/trajectory${buildQuery({
        from: query.from,
        to: query.to,
        include_unvalidated: query.include_unvalidated,
      })}`,
    ),

  getSightings: (query) =>
    request<Paginated<Sighting>>(
      `/sightings${buildQuery({
        camera_code: query.camera_code,
        plate: query.plate,
        validation_status: query.validation_status,
        from: query.from,
        to: query.to,
        limit: query.limit,
        offset: query.offset,
      })}`,
    ),

  getAlerts: (query) =>
    request<Paginated<Alert>>(
      `/alerts${buildQuery({
        alert_type: query.alert_type,
        status: query.status,
        severity: query.severity,
        anomaly_reason: query.anomaly_reason,
        plate: query.plate,
        camera_code: query.camera_code,
        from: query.from,
        to: query.to,
        limit: query.limit,
        offset: query.offset,
      })}`,
    ),

  getAlertCounts: (query) =>
    request<AlertCounts>(`/alerts/counts${buildQuery({ from: query.from, to: query.to })}`),

  acknowledgeAlert: (alertId, body) =>
    request<Alert>(`/alerts/${encodeURIComponent(alertId)}/acknowledge`, {
      method: 'POST',
      body,
    }),

  getBlacklist: (query) =>
    request<Paginated<BlacklistEntry>>(
      `/blacklist${buildQuery({
        status: query.status,
        severity: query.severity,
        q: query.q,
        limit: query.limit,
        offset: query.offset,
      })}`,
    ),

  createBlacklistEntry: (body) =>
    request<BlacklistEntry>('/blacklist', { method: 'POST', body }),

  updateBlacklistEntry: (entryId, body) =>
    request<BlacklistEntry>(`/blacklist/${encodeURIComponent(entryId)}`, {
      method: 'PATCH',
      body,
    }),

  getNodeMetrics: (query) =>
    request<NodeMetricsResponse>(`/analytics/nodes${buildQuery({ ...query })}`),

  getLinkCongestion: (query) =>
    request<LinkCongestionResponse>(`/analytics/links${buildQuery({ ...query })}`),

  getFlowTrends: (query) =>
    request<FlowTrendResponse>(
      `/analytics/flow-trends${buildQuery({
        from: query.from,
        to: query.to,
        scope: query.scope,
        target_id: query.target_id,
        bucket_minutes: query.bucket_minutes,
      })}`,
    ),

  getOriginDestination: (query) =>
    request<OriginDestinationResponse>(
      `/analytics/origin-destination${buildQuery({ ...query })}`,
    ),

  getReportPeriods: (granularity) =>
    request<ReportListResponse>(`/analytics/reports/periods${buildQuery({ granularity })}`),

  getReport: (granularity, period) =>
    request<CongestionReport>(`/analytics/reports${buildQuery({ granularity, period })}`),
};

/* ------------------------------------------------------------------ resolve -- */

/**
 * The mock transport, loaded on first use rather than imported statically.
 *
 * The fixture layer generates thousands of rows and is a substantial chunk. A
 * static import would bundle all of it into the entry chunk even when the app is
 * configured to talk to the real API, where it can never run.
 *
 * Every `ApiClient` method is already async, so a proxy that awaits the import
 * before delegating is transparent to callers — no call site needs to know.
 */
const lazyMockClient = new Proxy({} as ApiClient, {
  get(_target, property) {
    return async (...args: unknown[]) => {
      const { mockClient } = await import('./mock/transport');
      const method = (mockClient as unknown as Record<string, unknown>)[
        property as string
      ];
      if (typeof method !== 'function') {
        throw new ApiError(500, `Mock transport has no method "${String(property)}"`);
      }
      return (method as (...inner: unknown[]) => Promise<unknown>).apply(
        mockClient,
        args,
      );
    };
  },
});

export const apiClient: ApiClient = USE_MOCK ? lazyMockClient : httpClient;

export { httpClient };
