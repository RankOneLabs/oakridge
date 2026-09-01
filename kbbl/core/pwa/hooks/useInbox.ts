import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { useStore } from "../state/store";
import type { SessionSnapshot } from "../types";

interface SessionsListResponse {
  sessions: SessionSnapshot[];
}

// Mounts the inbox subscription: a one-shot seed query for the full list
// (archived pre-ACP sessions included) and a long-lived /inbox
// EventSource whose `snapshot` frames replace the ACP session list in the
// Zustand store wholesale. The server pushes a fresh snapshot on every
// session change — there are no deltas to fold, and a reconnect needs no
// replay reasoning because the next frame is always authoritative.
//
// Live data flows SSE → store, NOT through React Query. The seed query
// uses staleTime=Infinity / refetchOnMount=false because the SSE channel
// keeps the ACP half fresh and the archived half never changes.
//
// Foreground revival: when the browser backgrounds the PWA (e.g. tablet
// sleep) the EventSource can enter CLOSED state permanently. On
// visibilitychange or focus, if the source is CLOSED we rebuild it — the
// snapshot frame on reconnect re-seats everything missed. A CONNECTING
// source is the browser's own retry/backoff: we leave it alone to avoid
// resetting that backoff and hammering the server.
export function useInbox(opts: { onSessionRemoved?: (sid: string) => void } = {}): void {
  const seedSessions = useStore((s) => s.seedSessions);
  const applySnapshot = useStore((s) => s.applySnapshot);
  const setInboxStatus = useStore((s) => s.setInboxStatus);

  // Mirror the callback into a ref so the EventSource handler (set up once)
  // reads the latest closure on each frame instead of a stale one captured
  // at mount. Mutating in render — sanctioned by the React docs for this
  // always-fresh-callback pattern.
  const onSessionRemovedRef = useRef(opts.onSessionRemoved);
  onSessionRemovedRef.current = opts.onSessionRemoved;

  const seed = useQuery({
    queryKey: ["sessions", "archived"],
    queryFn: async (): Promise<SessionsListResponse> => {
      const res = await fetch("/sessions?include=archived");
      if (!res.ok) throw new Error(`sessions: ${res.status}`);
      return (await res.json()) as SessionsListResponse;
    },
    staleTime: Infinity,
    refetchOnMount: false,
  });

  useEffect(() => {
    if (!seed.data) return;
    seedSessions(seed.data.sessions);
  }, [seed.data, seedSessions]);

  useEffect(() => {
    let current: EventSource | null = null;
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (stopped) return;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      current?.close();
      setInboxStatus("connecting");
      const es = new EventSource("/inbox");
      current = es;

      es.onopen = () => setInboxStatus("connected");
      es.onerror = () => setInboxStatus("disconnected");

      es.addEventListener("snapshot", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as SessionsListResponse;
          const removed = applySnapshot(data.sessions);
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
