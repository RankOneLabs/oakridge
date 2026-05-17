import { useState, useEffect, useCallback, useRef } from "react";

import type {
  Status,
  InboxState,
  SessionSnapshot,
  InboxDelta,
  CompactSuggestion,
} from "../types";

export function useInbox(opts: { onSessionRemoved?: (sid: string) => void } = {}): InboxState {
  const [sessions, setSessions] = useState<Map<string, SessionSnapshot>>(
    () => new Map(),
  );
  const [inMemorySids, setInMemorySids] = useState<Set<string>>(
    () => new Set(),
  );
  const [inboxStatus, setInboxStatus] = useState<Status>("connecting");
  const [compactSuggestions, setCompactSuggestions] = useState<Map<string, CompactSuggestion>>(() => new Map());
  // Mirror onSessionRemoved into a ref so the EventSource handler (set up
  // once on mount) reads the latest closure on each delta — otherwise it
  // would call a stale callback that captured the initial render's sid.
  // Assign during render rather than in a passive useEffect so there's no
  // window between a re-render and the effect firing where a delta could
  // hit the previous callback. Mutating a ref during render is sanctioned
  // by the React docs for exactly this "always-fresh callback" pattern.
  const onSessionRemovedRef = useRef(opts.onSessionRemoved);
  onSessionRemovedRef.current = opts.onSessionRemoved;

  const hydrateSession = useCallback((snapshot: SessionSnapshot) => {
    setSessions((prev) => {
      const next = new Map(prev);
      next.set(snapshot.sid, snapshot);
      return next;
    });
    setInMemorySids((prev) => {
      if (prev.has(snapshot.sid)) return prev;
      const next = new Set(prev);
      next.add(snapshot.sid);
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Seed with the full list (in-memory + archived). The inbox snapshot
    // that arrives below will overwrite in-memory entries with fresher
    // copies; archived-only entries carry over untouched.
    fetch("/sessions?include=archived")
      .then((r) => r.json() as Promise<{ sessions: SessionSnapshot[] }>)
      .then((data) => {
        if (cancelled) return;
        setSessions((prev) => {
          const next = new Map(prev);
          for (const s of data.sessions) {
            if (!next.has(s.sid)) next.set(s.sid, s);
          }
          return next;
        });
        // Seed inMemorySids with every non-ended sid so SessionView picks
        // /:sid/stream (SSE) over one-shot /:sid/events when the user
        // clicks a live session before the /inbox SSE has connected. Only
        // non-ended sids: archived-on-disk entries (always status=ended)
        // would otherwise be incorrectly marked as in-memory.
        setInMemorySids((prev) => {
          const next = new Set(prev);
          for (const s of data.sessions) {
            if (s.status !== "ended") next.add(s.sid);
          }
          return next;
        });
      })
      .catch(() => {
        // Network error; the inbox subscription below still provides live
        // state, it just won't show prior-run archived sessions.
      });

    const es = new EventSource("/inbox");
    es.onopen = () => setInboxStatus("connected");
    es.onerror = () => setInboxStatus("disconnected");
    es.addEventListener("snapshot", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        sessions: SessionSnapshot[];
      };
      setSessions((prev) => {
        const next = new Map(prev);
        for (const s of data.sessions) next.set(s.sid, s);
        return next;
      });
      setInMemorySids(new Set(data.sessions.map((s) => s.sid)));
    });
    es.addEventListener("delta", (e) => {
      const delta = JSON.parse((e as MessageEvent).data) as InboxDelta;
      setSessions((prev) => applyDelta(prev, delta));
      if (delta.type === "session_created") {
        setInMemorySids((prev) => {
          if (prev.has(delta.session.sid)) return prev;
          const next = new Set(prev);
          next.add(delta.session.sid);
          return next;
        });
      }
      if (delta.type === "session_removed") {
        setInMemorySids((prev) => {
          if (!prev.has(delta.sid)) return prev;
          const next = new Set(prev);
          next.delete(delta.sid);
          return next;
        });
        // Fire the consumer callback AFTER state setters so a navigate(null)
        // it triggers lands on the same React batch as the map drop.
        onSessionRemovedRef.current?.(delta.sid);
      }
      // session_ended keeps the sid in inMemorySids: ended sessions linger
      // in the manager map (and stream/events still work against them)
      // until the server process exits. session_removed (purge) is what
      // actually drops the entry.
      if (delta.type === "compact_suggested") {
        setCompactSuggestions((prev) => {
          const next = new Map(prev);
          next.set(delta.sid, { sid: delta.sid, tokens: delta.tokens });
          return next;
        });
      }
      if (
        delta.type === "status_changed" &&
        (delta.status === "compacting" || delta.status === "ended")
      ) {
        setCompactSuggestions((prev) => {
          if (!prev.has(delta.sid)) return prev;
          const next = new Map(prev);
          next.delete(delta.sid);
          return next;
        });
      }
      if (delta.type === "session_ended") {
        setCompactSuggestions((prev) => {
          if (!prev.has(delta.sid)) return prev;
          const next = new Map(prev);
          next.delete(delta.sid);
          return next;
        });
      }
      if (delta.type === "session_compacted") {
        setCompactSuggestions((prev) => {
          if (!prev.has(delta.sid)) return prev;
          const next = new Map(prev);
          next.delete(delta.sid);
          return next;
        });
      }
    });

    return () => {
      cancelled = true;
      es.close();
    };
  }, []);

  const clearCompactSuggestion = useCallback((sid: string) => {
    setCompactSuggestions((prev) => {
      if (!prev.has(sid)) return prev;
      const next = new Map(prev);
      next.delete(sid);
      return next;
    });
  }, []);
  return { sessions, inMemorySids, inboxStatus, compactSuggestions, clearCompactSuggestion, hydrateSession };
}

function applyDelta(
  prev: Map<string, SessionSnapshot>,
  delta: InboxDelta,
): Map<string, SessionSnapshot> {
  const next = new Map(prev);
  switch (delta.type) {
    case "session_created":
      next.set(delta.session.sid, delta.session);
      break;
    case "session_ended": {
      const s = next.get(delta.sid);
      if (s) next.set(delta.sid, { ...s, status: "ended", pendingCount: 0 });
      break;
    }
    case "session_removed": {
      next.delete(delta.sid);
      break;
    }
    case "session_compacted": {
      const s = next.get(delta.sid);
      // Ordering: finalize() emits status_changed("ended"), then onEnded
      // broadcasts session_ended, then abort() resolves and session_compacted
      // is broadcast. By the time this case runs, status is already "ended".
      // Patch in endReason + successorSid so CompactedBanner has the data it
      // needs without waiting for a snapshot refetch. If the predecessor isn't
      // in the map (rare race during initial /sessions hydration), the next
      // snapshot fetch carries the same fields from disk.
      if (s) {
        next.set(delta.sid, {
          ...s,
          endReason: "compacted",
          successorSid: delta.successor_sid,
        });
      }
      break;
    }
    case "status_changed": {
      const s = next.get(delta.sid);
      if (s) next.set(delta.sid, { ...s, status: delta.status });
      break;
    }
    case "pending_count_changed": {
      const s = next.get(delta.sid);
      if (s) next.set(delta.sid, { ...s, pendingCount: delta.count });
      break;
    }
    case "last_activity_changed": {
      const s = next.get(delta.sid);
      if (s) next.set(delta.sid, { ...s, lastActivityTs: delta.ts });
      break;
    }
    case "yolo_changed": {
      const s = next.get(delta.sid);
      if (s) next.set(delta.sid, { ...s, yoloMode: delta.yoloMode });
      break;
    }
  }
  return next;
}
