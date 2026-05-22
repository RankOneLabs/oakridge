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
    const es = new EventSource("/inbox");
    es.onopen = () => setInboxStatus("connected");
    es.onerror = () => setInboxStatus("disconnected");

    es.addEventListener("snapshot", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as SessionsListResponse;
      applySnapshot(data.sessions);
    });

    es.addEventListener("delta", (e) => {
      const delta = JSON.parse((e as MessageEvent).data) as InboxDelta;
      applyInboxDelta(delta);
      if (delta.type === "session_removed") {
        // Fire consumer callback AFTER the store mutation so any navigate(null)
        // it triggers lands on the same React batch as the map drop.
        onSessionRemovedRef.current?.(delta.sid);
      }
    });

    return () => {
      es.close();
    };
  }, [applyInboxDelta, applySnapshot, setInboxStatus]);
}
