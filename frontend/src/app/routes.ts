/**
 * Route table. Kept as data rather than JSX so the sidebar, the header title and
 * the router all read from one definition and can't drift apart.
 */

import type { ComponentType, SVGProps } from 'react';

import {
  BellIcon,
  ChartIcon,
  MapIcon,
  ReportIcon,
  RouteIcon,
  ShieldIcon,
} from '@/components/icons';

export interface RouteMeta {
  path: string;
  label: string;
  /** Shown under the page title in the header. */
  description: string;
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;
  section: 'Operations' | 'Analysis' | 'Manage';
  /** Show the unacknowledged-alert count next to this item. */
  showAlertCount?: boolean;
}

export const ROUTES: readonly RouteMeta[] = [
  {
    path: '/map',
    label: 'Live map',
    description: 'Camera network, live sightings and current congestion',
    icon: MapIcon,
    section: 'Operations',
  },
  {
    path: '/trajectory',
    label: 'Plate trajectory',
    description: 'Search a plate and replay its route across the corridor',
    icon: RouteIcon,
    section: 'Operations',
  },
  {
    path: '/alerts',
    label: 'Alerts',
    description: 'Blacklist matches and route anomalies, with acknowledgement',
    icon: BellIcon,
    section: 'Operations',
    showAlertCount: true,
  },
  {
    path: '/analytics',
    label: 'Traffic analytics',
    description: 'Node load, link congestion, flow trends and origin–destination',
    icon: ChartIcon,
    section: 'Analysis',
  },
  {
    path: '/reports',
    label: 'Reports',
    description: 'Weekly and monthly congestion reporting',
    icon: ReportIcon,
    section: 'Analysis',
  },
  {
    path: '/blacklist',
    label: 'Blacklist',
    description: 'Watch-list entries and their enforcement window',
    icon: ShieldIcon,
    section: 'Manage',
  },
];

export const NAV_SECTIONS = ['Operations', 'Analysis', 'Manage'] as const;

export function routeMetaFor(pathname: string): RouteMeta | undefined {
  return ROUTES.find((route) => pathname.startsWith(route.path));
}
