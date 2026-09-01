import { useEffect, useState } from "react";

import type { AcpUiEvent, Status } from "../types";

export interface AcpSessionStream {
  events: AcpUiEvent[];
  streamStatus: Status;
  /** The agent could not replay this session's history (expired). */
  expired: boolean;
  /** Non-null when the stream endpoint refused the session outright. */
  streamError: string | null;
}

// One SSE subscription to /sessions/:sid/stream. The server opens every
// connection with an `epoch` frame and a full replay of the projection
// buffer, then live events — so the client holds no cross-connection
// offset state at all: each epoch frame resets the local timeline and the
// replay rebuilds it. Event ids only mean anything within one epoch
// (§14.4); a respawned controller gets a fresh epoch and a fresh replay.
//
// Replay batching: EventSource dispatches a replay as one message task per
// event; appending each separately would rebuild an increasingly large
// transcript hundreds of times. Events buffer per animation frame instead.
export function useAcpSession(sid: string, enabled = true): AcpSessionStream {
  const [events, setEvents] = useState<AcpUiEvent[]>([]);
  const [streamStatus, setStreamStatus] = useState<Status>("connecting");
  const [expired, setExpired] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);

  useEffect(() => {
    setEvents([]);
    setExpired(false);
    setStreamError(null);
    if (!enabled) {
      setStreamStatus("disconnected");
      return;
    }

    let current: EventSource | null = null;
    let stopped = false;
    let pending: AcpUiEvent[] = [];
    let pendingFrame: number | null = null;

    const flushPending = () => {
      pendingFrame = null;
      const batch = pending;
      pending = [];
      if (batch.length > 0) setEvents((prev) => [...prev, ...batch]);
    };
    const enqueue = (event: AcpUiEvent) => {
      pending.push(event);
      if (pendingFrame === null) pendingFrame = requestAnimationFrame(flushPending);
    };

    const connect = () => {
      if (stopped) return;
      current?.close();
      setStreamStatus("connecting");
      const es = new EventSource(`/sessions/${encodeURIComponent(sid)}/stream`);
      current = es;
      es.onopen = () => setStreamStatus("connected");
      es.onerror = () => setStreamStatus("disconnected");

      es.addEventListener("epoch", (e) => {
        // Every connection replays the whole buffer after its epoch
        // frame; drop whatever this client accumulated and rebuild.
        if (pendingFrame !== null) {
          cancelAnimationFrame(pendingFrame);
          pendingFrame = null;
        }
        pending = [];
        setEvents([]);
        setStreamError(null);
        try {
          const data = JSON.parse((e as MessageEvent).data) as {
            expired?: unknown;
          };
          setExpired(data.expired === true);
        } catch {
          setExpired(false);
        }
      });

      es.addEventListener("acp", (e) => {
        try {
          enqueue(JSON.parse((e as MessageEvent).data) as AcpUiEvent);
        } catch {
          // malformed frame; ignore
        }
      });
    };

    // The stream 404s/503s for unknown or unstreamable sessions — the
    // EventSource surfaces that only as a generic error, so probe once
    // with fetch when the source lands in CLOSED without ever opening.
    const probeFailure = async () => {
      try {
        const res = await fetch(`/sessions/${encodeURIComponent(sid)}/stream`, {
          method: "GET",
          headers: { accept: "text/event-stream" },
        });
        // The cleanup clears failTimer, so a probe never STARTS after
        // unmount — but one already in flight can resolve after it.
        if (stopped) {
          await res.body?.cancel().catch(() => {});
          return;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: unknown;
          } | null;
          if (stopped) return;
          setStreamError(
            typeof body?.error === "string"
              ? body.error
              : `stream unavailable (${res.status})`,
          );
        } else {
          // The probe itself opened a stream; discard it.
          await res.body?.cancel().catch(() => {});
        }
      } catch {
        // Network-level failure: leave streamStatus to tell the story.
      }
    };

    let probed = false;
    const reviveIfStale = () => {
      if (document.visibilityState !== "visible") return;
      // Only rebuild when the browser has actually given up (CLOSED) or
      // there's no source — a CONNECTING source is the browser's own
      // retry/backoff in flight after a transient drop.
      if (!current || current.readyState === EventSource.CLOSED) connect();
    };

    connect();
    const failTimer = setTimeout(() => {
      if (
        !probed &&
        current?.readyState === EventSource.CLOSED
      ) {
        probed = true;
        void probeFailure();
      }
    }, 2000);
    document.addEventListener("visibilitychange", reviveIfStale);
    window.addEventListener("focus", reviveIfStale);

    return () => {
      stopped = true;
      clearTimeout(failTimer);
      document.removeEventListener("visibilitychange", reviveIfStale);
      window.removeEventListener("focus", reviveIfStale);
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
      current?.close();
    };
  }, [sid, enabled]);

  return { events, streamStatus, expired, streamError };
}
