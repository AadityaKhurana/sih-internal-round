import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { AppLayout } from '@/app/AppLayout';
import { Loading } from '@/components/ui';
import { NotFoundPage } from '@/pages/NotFoundPage';

/**
 * Routes are code-split.
 *
 * Leaflet and Recharts are the two heaviest dependencies and neither is needed to
 * paint the shell, so each page loads on navigation. Without this the whole
 * dashboard shipped as one 535 kB chunk, which is a slow first paint for an
 * operator who only wanted the alert list.
 *
 * `NotFoundPage` stays eager — it is tiny, and a chunk fetch that fails should not
 * be the thing standing between the user and the error page.
 */
const MapPage = lazy(async () => ({ default: (await import('@/pages/MapPage')).MapPage }));
const TrajectoryPage = lazy(async () => ({
  default: (await import('@/pages/TrajectoryPage')).TrajectoryPage,
}));
const AlertsPage = lazy(async () => ({
  default: (await import('@/pages/AlertsPage')).AlertsPage,
}));
const AnalyticsPage = lazy(async () => ({
  default: (await import('@/pages/AnalyticsPage')).AnalyticsPage,
}));
const ReportsPage = lazy(async () => ({
  default: (await import('@/pages/ReportsPage')).ReportsPage,
}));
const BlacklistPage = lazy(async () => ({
  default: (await import('@/pages/BlacklistPage')).BlacklistPage,
}));

function PageFallback() {
  return (
    <div className="page">
      <Loading label="Loading view…" />
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Navigate to="/map" replace />} />
        <Route
          path="/map"
          element={
            <Suspense fallback={<PageFallback />}>
              <MapPage />
            </Suspense>
          }
        />
        <Route
          path="/trajectory"
          element={
            <Suspense fallback={<PageFallback />}>
              <TrajectoryPage />
            </Suspense>
          }
        />
        <Route
          path="/alerts"
          element={
            <Suspense fallback={<PageFallback />}>
              <AlertsPage />
            </Suspense>
          }
        />
        <Route
          path="/analytics"
          element={
            <Suspense fallback={<PageFallback />}>
              <AnalyticsPage />
            </Suspense>
          }
        />
        <Route
          path="/reports"
          element={
            <Suspense fallback={<PageFallback />}>
              <ReportsPage />
            </Suspense>
          }
        />
        <Route
          path="/blacklist"
          element={
            <Suspense fallback={<PageFallback />}>
              <BlacklistPage />
            </Suspense>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
