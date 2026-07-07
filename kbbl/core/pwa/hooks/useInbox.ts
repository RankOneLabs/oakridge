import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { useStore } from "../state/store";
import type { InboxDelta, SessionSnapshot } from "../types";

interface SessionsListResponse {
  sessions: SessionSnapshot[];
}

// Mounts the inbox subscription: a one-shot seed query for the in-memory +
// archived session list and a long-lived /inbox EventSource whose snapshot
// and delta events fold into the Zustand store. The hook returns void —
// consumers read the inbox snapshot, status, and compact-suggestion map
// directly from `useStore`.
//
// Live data flows SSE → store, NOT through React Query. The seed query uses
// staleTime=Infinity / refetchOnMount=false because the SSE channel is what
// keeps the snapshot fresh; a refetch would only race the deltas.
//
// Foreground revival: when the browser backgrounds the PWA (e.g. tablet
// sleep) the EventSource can enter CLOSED state permanently. On
// visibilitychange or focus, if the source is CLOSED we rebuild it — the
// snapshot frame on reconnect re-seats any missed deltas. A CONNECTING source
// is the browser's own retry/backoff: we leave it alone to avoid resetting
// that backoff and hammering the server.
export function useInbox(opts: { onSessionRemoved?: (sid: string) => void } = {}): void {
  const seedSessions = useStore((s) => s.seedSessions);
  const applySnapshot = useStore((s) => s.applySnapshot);
  const applyInboxDelta = useStore((s) => s.applyInboxDelta);
  const setInboxStatus = useStore((s) => s.setInboxStatus);

  // Mirror the callback into a ref so the EventSource handler (set up once)
  // reads the latest closure on each delta instead of a stale one captured
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

    const connect = () => {
      if (stopped) return;
      current?.close();
      setInboxStatus("connecting");
      const es = new EventSource("/inbox");
      current = es;

      es.onopen = () => setInboxStatus("connected");
      es.onerror = () => setInboxStatus("disconnected");

      es.addEventListener("snapshot", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as SessionsListResponse;
          applySnapshot(data.sessions);
        } catch {
          setInboxStatus("stale");
        }
      });

      es.addEventListener("delta", (e) => {
        try {
          const delta = JSON.parse((e as MessageEvent).data) as InboxDelta;
          applyInboxDelta(delta);
          if (delta.type === "session_removed") {
            // Fire consumer callback AFTER the store mutation so any navigate(null)
            // it triggers lands on the same React batch as the map drop.
            onSessionRemovedRef.current?.(delta.sid);
          }
        } catch {
          setInboxStatus("stale");
        }
      });
    };

    const reviveIfStale = () => {
      if (document.visibilityState !== "visible") return;
      // Only rebuild when the browser has actually given up (CLOSED) or there's
      // no source. A CONNECTING source is the browser's own retry/backoff in
      // flight after a transient drop — tearing it down on every focus event
      // would reset that backoff and could hammer the server.
      if (!current || current.readyState === EventSource.CLOSED) connect();
    };

    connect();
    document.addEventListener("visibilitychange", reviveIfStale);
    window.addEventListener("focus", reviveIfStale);

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", reviveIfStale);
      window.removeEventListener("focus", reviveIfStale);
      current?.close();
    };
  }, [applyInboxDelta, applySnapshot, setInboxStatus]);
}
