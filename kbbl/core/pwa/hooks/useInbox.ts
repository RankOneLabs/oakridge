import { useEffect, useRef } from "react";

import { useStore } from "../state/store";
import type { SessionSnapshot } from "../types";
import { selectPendingPermissionToasts, useToastStore } from "./useToast";
import { LiveSubscription } from "../lib/live-stream";

interface SessionsListResponse {
  sessions: SessionSnapshot[];
}

// Mounts the inbox subscription: a logical /inbox subscription on the page's
// shared feed whose `snapshot` frames replace the session list in the
// Zustand store wholesale. The server pushes a fresh snapshot on every
// session change — there are no deltas to fold, and a reconnect needs no
// replay reasoning because the next frame is always authoritative.
//
// Live data flows SSE → store, NOT through React Query.
//
// Foreground revival: when the browser backgrounds the PWA (e.g. tablet
// sleep) the EventSource can enter CLOSED state permanently. On
// visibilitychange or focus, if the source is CLOSED we rebuild it — the
// snapshot frame on reconnect re-seats everything missed. A CONNECTING
// source is the browser's own retry/backoff: we leave it alone to avoid
// resetting that backoff and hammering the server.
export function useInbox(opts: { onSessionRemoved?: (sid: string) => void } = {}): void {
  const applySnapshot = useStore((s) => s.applySnapshot);
  const setInboxStatus = useStore((s) => s.setInboxStatus);

  // Mirror the callback into a ref so the EventSource handler (set up once)
  // reads the latest closure on each frame instead of a stale one captured
  // at mount. Mutating in render — sanctioned by the React docs for this
  // always-fresh-callback pattern.
  const onSessionRemovedRef = useRef(opts.onSessionRemoved);
  onSessionRemovedRef.current = opts.onSessionRemoved;

  useEffect(() => {
    let current: LiveSubscription | null = null;
    let stopped = false;
    let hasSnapshotBaseline = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (stopped) return;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      current?.close();
      setInboxStatus("connecting");
      const es = new LiveSubscription("/inbox");
      current = es;

      es.onopen = () => setInboxStatus("connected");
      es.onerror = () => setInboxStatus("disconnected");

      es.addEventListener("snapshot", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as SessionsListResponse;
          const permissionToasts = hasSnapshotBaseline
            ? selectPendingPermissionToasts(
                [...useStore.getState().sessions.values()],
                data.sessions,
              )
            : [];
          const removed = applySnapshot(data.sessions);
          hasSnapshotBaseline = true;
          for (const toast of permissionToasts) useToastStore.getState().pushToast(toast);
          // Fire consumer callbacks AFTER the store mutation so any
          // navigate(null) they trigger lands on the same React batch as
          // the map drop.
          for (const sid of removed) onSessionRemovedRef.current?.(sid);
        } catch {
          markStaleAndReconnect();
        }
      });
    };

    function markStaleAndReconnect() {
      if (stopped) return;
      setInboxStatus("stale");
      current?.close();
      if (reconnectTimer !== null) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 0);
    }

    const reviveIfStale = () => {
      if (document.visibilityState !== "visible") return;
      // Only rebuild when the browser has actually given up (CLOSED) or
      // there's no source — a CONNECTING source is the browser's own
      // retry/backoff in flight after a transient drop.
      if (!current || current.readyState === EventSource.CLOSED) connect();
    };

    connect();
    document.addEventListener("visibilitychange", reviveIfStale);
    window.addEventListener("focus", reviveIfStale);

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", reviveIfStale);
      window.removeEventListener("focus", reviveIfStale);
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      current?.close();
    };
  }, [applySnapshot, setInboxStatus]);
}
