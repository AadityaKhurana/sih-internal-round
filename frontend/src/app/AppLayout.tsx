import { useCallback, useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';

import { AlertDock } from '@/features/alerts/AlertDock';
import { useLive } from '@/features/live/LiveProvider';
import { cx } from '@/lib/cx';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import './layout.css';

const DOCK_STORAGE_KEY = 'anpr.dock.open';

function readDockPreference(): boolean {
  try {
    const stored = window.localStorage.getItem(DOCK_STORAGE_KEY);
    return stored === null ? true : stored === 'true';
  } catch {
    return true;
  }
}

/**
 * The shell every route renders inside.
 *
 * The alert dock is part of the frame rather than a page, because an operator
 * looking at a traffic report still needs to see a blacklist hit the moment it
 * lands. It can be collapsed, and the preference persists — but collapsing it
 * moves the unseen count onto the header button rather than hiding it.
 */
export function AppLayout() {
  const [dockOpen, setDockOpen] = useState(readDockPreference);
  const { markSeen, unseenCount } = useLive();

  useEffect(() => {
    try {
      window.localStorage.setItem(DOCK_STORAGE_KEY, String(dockOpen));
    } catch {
      // Preference is session-only if storage is unavailable.
    }
  }, [dockOpen]);

  // With the dock visible, incoming alerts are considered seen.
  useEffect(() => {
    if (dockOpen && unseenCount > 0) markSeen();
  }, [dockOpen, unseenCount, markSeen]);

  const toggleDock = useCallback(() => setDockOpen((open) => !open), []);

  return (
    <div className="shell">
      <Sidebar />
      <Header dockOpen={dockOpen} onToggleDock={toggleDock} />
      <div className={cx('shell__main', dockOpen && 'has-dock')}>
        <div className="shell__content">
          <Outlet />
        </div>
        {dockOpen ? (
          <div className="shell__dock">
            <AlertDock onClose={toggleDock} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
