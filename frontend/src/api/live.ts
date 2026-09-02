/**
 * Live feed transport.
 *
 * Real mode opens a WebSocket to `VITE_WS_URL` and reconnects with exponential
 * backoff. Dropped frames are not treated as fatal: the consumer refetches
 * `/alerts` on every reconnect, so a gap in the socket closes itself instead of
 * leaving the dock quietly stale — which would be worse than showing nothing.
 *
 * Mock mode returns the simulated emitter. Same interface either way.
 */

import type { ConnectionState, LiveClientMessage, LiveMessage, LiveTopic } from '@/types/api';
import { USE_MOCK, WS_URL } from './config';
import type { LiveConnection } from './live-types';

export type { LiveConnection };

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

/** Resolve a possibly-relative WS path against the page origin. */
function resolveWsUrl(path: string): string {
  if (path.startsWith('ws://') || path.startsWith('wss://')) return path;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path.startsWith('/') ? path : `/${path}`}`;
}

function createWebSocketConnection(topics: LiveTopic[]): LiveConnection {
  const messageListeners = new Set<(message: LiveMessage) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();

  let socket: WebSocket | null = null;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closedByCaller = false;
  let state: ConnectionState = 'connecting';

  const setState = (next: ConnectionState) => {
    if (state === next) return;
    state = next;
    for (const listener of stateListeners) listener(next);
  };

  const connect = () => {
    if (closedByCaller) return;

    setState(attempt === 0 ? 'connecting' : 'reconnecting');
    socket = new WebSocket(resolveWsUrl(WS_URL));

    socket.onopen = () => {
      attempt = 0;
      setState('open');
      const subscribe: LiveClientMessage = { type: 'subscribe', topics };
      socket?.send(JSON.stringify(subscribe));
    };

    socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as LiveMessage;
        for (const listener of messageListeners) listener(parsed);
      } catch {
        // A frame we can't parse is dropped rather than crashing the feed. The
        // periodic refetch is the safety net for anything missed this way.
      }
    };

    socket.onerror = () => {
      // `onclose` always follows; the retry is handled there.
    };

    socket.onclose = () => {
      socket = null;
      if (closedByCaller) {
        setState('closed');
        return;
      }
      const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30_000;
      attempt += 1;
      setState('reconnecting');
      reconnectTimer = setTimeout(connect, wait);
    };
  };

  connect();

  return {
    getState: () => state,
    onMessage: (listener) => {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onState: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    close: () => {
      closedByCaller = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      socket = null;
      messageListeners.clear();
      stateListeners.clear();
      state = 'closed';
    },
  };
}

/**
 * Open a live feed.
 *
 * Async because the mock emitter is code-split: it is built on the fixture layer,
 * which must not ship to a deployment that talks to the real service. The real
 * WebSocket path resolves immediately.
 */
export async function createLiveConnection(
  topics: LiveTopic[] = ['alerts', 'sightings'],
): Promise<LiveConnection> {
  if (!USE_MOCK) return createWebSocketConnection(topics);
  const { createMockLiveConnection } = await import('./mock/live');
  return createMockLiveConnection();
}

export const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
  closed: 'Disconnected',
  mock: 'Simulated feed',
};
