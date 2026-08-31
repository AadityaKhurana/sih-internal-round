import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  useCameraLinks,
  useCameras,
  useFlowTrends,
  useLinkCongestion,
  useNodeMetrics,
  useOriginDestination,
} from '@/api/hooks';
import { SimulatedNetworkNotice } from '@/components/SimulatedNetworkNotice';
import {
  Card,
  EmptyState,
  ErrorState,
  Legend,
  Loading,
  SegmentedControl,
  Select,
  StatTile,
  Tabs,
} from '@/components/ui';
import { FlowTrendChart } from '@/features/analytics/FlowTrendChart';
import { LinkMetricsTable } from '@/features/analytics/LinkMetricsTable';
import { NodeLoadPanel } from '@/features/analytics/NodeLoadPanel';
import { OriginDestinationMatrix } from '@/features/analytics/OriginDestinationMatrix';
import { WINDOW_PRESETS, useAnalyticsWindow } from '@/features/analytics/window';
import { MapPanel } from '@/features/map/MapPanel';
import { NetworkMap } from '@/features/map/NetworkMap';
import {
  CONGESTION_LEGEND,
  congestionLevel,
  formatCount,
  formatScore,
  isLowSample,
} from '@/lib/congestion';
import { formatSpeed } from '@/lib/geo';
import type { FlowTrendScope } from '@/types/api';
import type { LinkCongestion, NodeMetric } from '@/types/domain';
import '@/features/analytics/analytics.css';

type AnalyticsTab = 'network' | 'trends' | 'od' | 'links';

const TABS = [
  { value: 'network', label: 'Network load' },
  { value: 'trends', label: 'Flow trends' },
  { value: 'od', label: 'Origin–destination' },
  { value: 'links', label: 'Link congestion & speed' },
] as const;

const MAP_MODES = [
  { value: 'load', label: 'Node heatmap', title: 'Camera markers sized by volume' },
  { value: 'congestion', label: 'Link congestion', title: 'Links coloured by travel time' },
] as const;

/**
 * Macro traffic analytics.
 *
 * Four views over the 5-minute metric tables: where the volume is (node), how the
 * corridors are running (link), how both move over time (trends), and where trips
 * actually start and end (origin–destination). All four share one time window so
 * numbers on different tabs are comparable.
 */
export function AnalyticsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const window = useAnalyticsWindow('3h');

  const [tab, setTab] = useState<AnalyticsTab>('network');
  const [mapMode, setMapMode] = useState<'load' | 'congestion'>('load');
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);

  const focusCamera = searchParams.get('camera');

  const cameras = useCameras();
  const links = useCameraLinks();
  const nodes = useNodeMetrics(window.query);
  const congestion = useLinkCongestion(window.query);

  // Trend scope follows what the operator has focused: a camera from the map, a
  // link from the table, otherwise the whole network.
  const trendScope: FlowTrendScope = selectedLinkId
    ? 'link'
    : focusCamera
      ? 'camera'
      : 'network';
  const trendTarget = selectedLinkId ?? focusCamera ?? undefined;

  const trends = useFlowTrends(
    {
      ...window.query,
      scope: trendScope,
      ...(trendTarget ? { target_id: trendTarget } : {}),
      bucket_minutes: window.bucketMinutes,
    },
    tab === 'trends',
  );

  const od = useOriginDestination(window.query, tab === 'od');

  const nodeMetricsById = useMemo(() => {
    const map = new Map<string, NodeMetric>();
    for (const node of nodes.data?.nodes ?? []) map.set(node.camera_id, node);
    return map;
  }, [nodes.data]);

  const congestionById = useMemo(() => {
    const map = new Map<string, LinkCongestion>();
    for (const link of congestion.data?.links ?? []) map.set(link.camera_link_id, link);
    return map;
  }, [congestion.data]);

  const summary = useMemo(() => {
    const nodeList = nodes.data?.nodes ?? [];
    const linkList = congestion.data?.links ?? [];
    const scored = linkList.filter((link) => link.congestion_score !== null);
    const measured = linkList.filter((link) => link.derived_speed_kph !== null);

    const worst = [...scored].sort(
      (a, b) => (b.congestion_score ?? 0) - (a.congestion_score ?? 0),
    )[0];

    return {
      vehicles: nodeList.reduce((sum, node) => sum + node.vehicle_count, 0),
      uniquePlates: nodeList.reduce((sum, node) => sum + node.unique_plate_count, 0),
      avgScore: congestion.data?.network_avg_congestion_score ?? null,
      avgSpeed:
        measured.length === 0
          ? null
          : measured.reduce((sum, link) => sum + (link.derived_speed_kph ?? 0), 0) /
            measured.length,
      worst,
      unmeasuredLinks: linkList.length - scored.length,
      lowSampleLinks: scored.filter((link) => isLowSample(link.travel_time_sample_count))
        .length,
      offlineCameras: nodeList.filter(
        (node) => node.status === 'fault' || node.status === 'inactive',
      ).length,
    };
  }, [nodes.data, congestion.data]);

  if (cameras.isError || links.isError || nodes.isError || congestion.isError) {
    return (
      <div className="page">
        <ErrorState
          error={cameras.error ?? links.error ?? nodes.error ?? congestion.error}
          onRetry={() => {
            void nodes.refetch();
            void congestion.refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <SimulatedNetworkNotice detail="Metrics are aggregated from a synthetic observation model over the simulated network." />

      <div className="window-bar">
        <Select
          label="Window"
          small
          value={window.preset.value}
          options={WINDOW_PRESETS.map((preset) => ({
            value: preset.value,
            label: preset.label,
          }))}
          onChange={(event) => window.setPreset(event.target.value)}
        />
        <span className="u-dim" style={{ fontSize: 'var(--fs-2xs)' }}>
          {new Date(window.query.from).toLocaleString()} →{' '}
          {new Date(window.query.to).toLocaleString()} · 5-minute windows rolled up
        </span>
      </div>

      <div className="page__grid page__grid--stats">
        <StatTile
          label="Vehicles recorded"
          value={formatCount(summary.vehicles)}
          footNote="across all cameras"
        />
        <StatTile
          label="Unique plates"
          value={formatCount(summary.uniquePlates)}
          footNote="sum of per-window uniques"
        />
        <StatTile
          label="Network congestion"
          value={formatScore(summary.avgScore)}
          unit="× free flow"
          footNote={`${congestionLevel(summary.avgScore) === 'unknown' ? 'no data' : congestionLevel(summary.avgScore)} on average`}
        />
        <StatTile
          label="Mean corridor speed"
          value={summary.avgSpeed === null ? '—' : summary.avgSpeed.toFixed(1)}
          unit="km/h"
          footNote="derived, not stored"
        />
        <StatTile
          label="Worst corridor"
          value={
            summary.worst
              ? `${summary.worst.from_camera_code}→${summary.worst.to_camera_code}`
              : '—'
          }
          footNote={
            summary.worst
              ? `${formatScore(summary.worst.congestion_score)}× · ${formatSpeed(summary.worst.derived_speed_kph)}`
              : 'no matched journeys'
          }
        />
      </div>

      {summary.unmeasuredLinks > 0 || summary.offlineCameras > 0 ? (
        <p className="sample-warning">
          {summary.unmeasuredLinks > 0
            ? `${summary.unmeasuredLinks} link(s) have no matched journeys in this window and report no travel time. `
            : ''}
          {summary.lowSampleLinks > 0
            ? `${summary.lowSampleLinks} link(s) are below the 5-journey confidence threshold. `
            : ''}
          {summary.offlineCameras > 0
            ? `${summary.offlineCameras} camera(s) are down, so links through them cannot be measured.`
            : ''}
        </p>
      ) : null}

      <Tabs ariaLabel="Analytics view" value={tab} tabs={TABS} onChange={setTab} />

      {tab === 'network' ? (
        <>
          <div className="analytics-map">
            <NetworkMap
              cameras={cameras.data?.features ?? []}
              links={links.data?.features ?? []}
              nodeMetricsById={nodeMetricsById}
              maxVehicleCount={nodes.data?.max_vehicle_count ?? 0}
              cameraColorMode={mapMode === 'load' ? 'load' : 'status'}
              linkColorMode={mapMode === 'congestion' ? 'congestion' : 'network'}
              congestionById={congestionById}
              selectedLinkId={selectedLinkId}
              selectedCameraId={
                focusCamera
                  ? (cameras.data?.features.find(
                      (feature) => feature.properties.camera_code === focusCamera,
                    )?.properties.camera_id ?? null)
                  : null
              }
              onSelectCamera={(camera) =>
                setSearchParams(
                  camera.properties.camera_code === focusCamera
                    ? {}
                    : { camera: camera.properties.camera_code },
                  { replace: true },
                )
              }
              onSelectLink={(link) =>
                setSelectedLinkId((current) =>
                  current === link.properties.camera_link_id
                    ? null
                    : link.properties.camera_link_id,
                )
              }
              onShowTrend={(code) => {
                setSelectedLinkId(null);
                setSearchParams({ camera: code }, { replace: true });
                setTab('trends');
              }}
              overlayTopLeft={
                <MapPanel tight>
                  <SegmentedControl
                    ariaLabel="Map encoding"
                    value={mapMode}
                    options={MAP_MODES}
                    onChange={setMapMode}
                  />
                </MapPanel>
              }
              overlayBottomLeft={
                mapMode === 'congestion' ? (
                  <MapPanel title="Travel time vs free flow">
                    <Legend items={CONGESTION_LEGEND} />
                  </MapPanel>
                ) : undefined
              }
            />
          </div>

          <div className="page__grid page__grid--2">
            <Card
              title="Camera node load"
              subtitle="Vehicles recorded per camera, ranked"
            >
              {nodes.isLoading ? (
                <Loading />
              ) : (
                <NodeLoadPanel
                  nodes={nodes.data?.nodes ?? []}
                  maxVehicleCount={nodes.data?.max_vehicle_count ?? 0}
                  selectedCameraCode={focusCamera}
                  onSelectCamera={(code) =>
                    setSearchParams(code === focusCamera ? {} : { camera: code }, {
                      replace: true,
                    })
                  }
                />
              )}
            </Card>

            <Card
              title="Worst corridors"
              subtitle="Ranked by travel time against free flow"
            >
              {congestion.isLoading ? (
                <Loading />
              ) : (
                <LinkMetricsTable
                  links={(congestion.data?.links ?? [])
                    .filter((link) => link.congestion_score !== null)
                    .slice(0, 40)}
                  selectedLinkId={selectedLinkId}
                  onSelectLink={(link) => setSelectedLinkId(link.camera_link_id)}
                />
              )}
            </Card>
          </div>
        </>
      ) : null}

      {tab === 'trends' ? (
        <Card
          title={
            trends.data ? `Flow trend — ${trends.data.target_label}` : 'Flow trend'
          }
          subtitle={
            trends.data
              ? `${trends.data.bucket_minutes}-minute buckets · ${trends.data.points.length} points`
              : undefined
          }
          actions={
            trendScope !== 'network' ? (
              <button
                type="button"
                className="ui-btn ui-btn--sm"
                onClick={() => {
                  setSelectedLinkId(null);
                  setSearchParams({}, { replace: true });
                }}
              >
                Show whole network
              </button>
            ) : undefined
          }
        >
          {trends.isLoading ? (
            <Loading label="Aggregating trend…" />
          ) : trends.isError ? (
            <ErrorState error={trends.error} onRetry={() => void trends.refetch()} />
          ) : trends.data && trends.data.points.length > 0 ? (
            <>
              <FlowTrendChart data={trends.data} showCongestion={trendScope === 'link'} />
              <p className="ui-field__hint" style={{ marginTop: 'var(--sp-2)' }}>
                The dashed line is the window-of-week baseline. Volume above baseline is
                what makes a peak unusual rather than merely busy.
                {trendScope === 'network'
                  ? ' Select a camera on the network tab, or a link in the congestion table, to scope this chart.'
                  : ''}
              </p>
            </>
          ) : (
            <EmptyState icon="⬚" title="No data in this window" />
          )}
        </Card>
      ) : null}

      {tab === 'od' ? (
        <Card
          title="Origin–destination matrix"
          subtitle="Completed journeys by first and last camera"
        >
          {od.isLoading ? (
            <Loading label="Matching journeys…" />
          ) : od.isError ? (
            <ErrorState error={od.error} onRetry={() => void od.refetch()} />
          ) : od.data ? (
            <OriginDestinationMatrix data={od.data} />
          ) : null}
        </Card>
      ) : null}

      {tab === 'links' ? (
        <Card
          title="Link congestion and derived speed"
          subtitle={`All ${congestion.data?.links.length ?? 0} directed links in the window`}
        >
          {congestion.isLoading ? (
            <Loading />
          ) : (
            <LinkMetricsTable
              links={congestion.data?.links ?? []}
              selectedLinkId={selectedLinkId}
              onSelectLink={(link) => {
                setSelectedLinkId(link.camera_link_id);
                setTab('trends');
              }}
            />
          )}
        </Card>
      ) : null}

    </div>
  );
}
