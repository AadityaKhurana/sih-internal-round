/**
 * Live feed context.
 *
 * One WebSocket (or one simulated emitter) for the whole app, shared through
 * context, so the header status pill, the alert dock and the live ticker on the
 * map all read the same connection instead of opening three.
 *
 * Two behaviours worth knowing about:
 *
 *  1. Buffers are capped ring buffers. A control room left open all day would
 *     otherwise accumulate unbounded arrays; the authoritative history lives in
 *     the API, and these are only the recent tail.
 *
 *  2. On every reconnect the cached alert queries are invalidated. Frames dropped
 *     while the socket was down are gone for good, so the feed cannot be treated
 *     as the source of truth — refetching is what stops the dock going quietly
 *     stale, which is a worse failure than showing a gap.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { createLiveConnection } from "@/api/live";
import { queryKeys } from "@/api/queryKeys";
import type { ConnectionState, LiveSighting } from "@/types/api";
import type { Alert } from "@/types/domain";

const MAX_ALERTS = 60;
const MAX_SIGHTINGS = 40;

export interface LiveContextValue {
  state: ConnectionState;
  /** Alerts delivered over the feed this session, newest first. */
  liveAlerts: Alert[];
  /** Recent sightings for the ticker, newest first. */
  liveSightings: LiveSighting[];
  lastMessageAt: number | null;
  /** Alerts received since the operator last looked at the dock. */
  unseenCount: number;
  markSeen: () => void;
  /** Number of completed reconnects — a cheap "we may have missed frames" signal. */
  reconnectCount: number;
}

const LiveContext = createContext<LiveContextValue | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const [state, setState] = useState<ConnectionState>("connecting");
  const [liveAlerts, setLiveAlerts] = useState<Alert[]>([]);
  const [liveSightings, setLiveSightings] = useState<LiveSighting[]>([]);
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  const [unseenCount, setUnseenCount] = useState(0);
  const [reconnectCount, setReconnectCount] = useState(0);

  // Tracks the previous state so a transition *into* `open` can be detected.
  const previousState = useRef<ConnectionState>("connecting");

  useEffect(() => {
    // The mock emitter is code-split, so opening the feed is async. `cancelled`
    // guards against a strict-mode remount resolving after the cleanup has run,
    // which would otherwise leave an orphaned connection running.
    let cancelled = false;
    let teardown: (() => void) | undefined;

    void createLiveConnection(["alerts", "sightings"]).then((connection) => {
      if (cancelled) {
        connection.close();
        return;
      }
      teardown = attach(connection);
    });

    return () => {
      cancelled = true;
      teardown?.();
    };

    /** Wire the listeners and return a cleanup that removes them. */
    function attach(
      connection: Awaited<ReturnType<typeof createLiveConnection>>,
    ) {
      setState(connection.getState());

      const offState = connection.onState((next) => {
        const was = previousState.current;
        previousState.current = next;
        setState(next);

        if (next === "open" && (was === "reconnecting" || was === "closed")) {
          setReconnectCount((count) => count + 1);
          // Close the gap left by frames dropped while the socket was down.
          void queryClient.invalidateQueries({
            queryKey: queryKeys.alertsRoot(),
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.alertCountsRoot(),
          });
        }
      });

      const offMessage = connection.onMessage((message) => {
        setLastMessageAt(Date.now());

        switch (message.type) {
          case "alert": {
            const incoming = message.alert;
            setLiveAlerts((current) => {
              // `dedup_key` is the schema's uniqueness guarantee; a redelivery
              // must not show up as a second alert.
              if (
                current.some((alert) => alert.dedup_key === incoming.dedup_key)
              ) {
                return current;
              }
              return [incoming, ...current].slice(0, MAX_ALERTS);
            });
            setUnseenCount((count) => count + 1);
            void queryClient.invalidateQueries({
              queryKey: queryKeys.alertsRoot(),
            });
            void queryClient.invalidateQueries({
              queryKey: queryKeys.alertCountsRoot(),
            });
            break;
          }
          case "sighting": {
            setLiveSightings((current) =>
              [message.sighting, ...current].slice(0, MAX_SIGHTINGS),
            );
            break;
          }
          case "alert_ack": {
            // Another operator acted; reflect it locally straight away.
            setLiveAlerts((current) =>
              current.map((alert) =>
                alert.alert_id === message.alert_id
                  ? {
                      ...alert,
                      status: message.status,
                      acknowledged_by: message.acknowledged_by,
                      acknowledged_at: message.acknowledged_at,
                    }
                  : alert,
              ),
            );
            void queryClient.invalidateQueries({
              queryKey: queryKeys.alertsRoot(),
            });
            break;
          }
          case "hello":
          case "heartbeat":
            break;
        }
      });

      return () => {
        offState();
        offMessage();
        connection.close();
      };
    }
  }, [queryClient]);

  const markSeen = useCallback(() => setUnseenCount(0), []);

  const value = useMemo<LiveContextValue>(
    () => ({
      state,
      liveAlerts,
      liveSightings,
      lastMessageAt,
      unseenCount,
      markSeen,
      reconnectCount,
    }),
    [
      state,
      liveAlerts,
      liveSightings,
      lastMessageAt,
      unseenCount,
      markSeen,
      reconnectCount,
    ],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveContextValue {
  const context = useContext(LiveContext);
  if (!context) throw new Error("useLive must be used inside <LiveProvider>");
  return context;
}
