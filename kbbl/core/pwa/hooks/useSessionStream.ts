import { useEffect, useRef, useState } from "react";

import type { EnvelopeEvent, ResolutionMap, Status } from "../types";

export interface SessionStreamState {
  events: EnvelopeEvent[];
  streamStatus: Status;
  resolutions: ResolutionMap;
  yoloMode: boolean;
  allowedTools: Set<string>;
}

export function useSessionStream(
  sid: string,
  inMemory: boolean,
  onPtyOutput?: (content: string) => void,
): SessionStreamState {
  const [events, setEvents] = useState<EnvelopeEvent[]>([]);
  const [streamStatus, setStreamStatus] = useState<Status>("connecting");
  const [resolutions, setResolutions] = useState<ResolutionMap>(
    () => new Map(),
  );
  const [yoloMode, setYoloMode] = useState(false);
  const [allowedTools, setAllowedTools] = useState<Set<string>>(
    () => new Set(),
  );
  const seenIds = useRef<Set<number>>(new Set());
  // Held in a ref so a changing callback identity doesn't churn the SSE
  // effect (which would tear down and reconnect the EventSource).
  const onPtyOutputRef = useRef(onPtyOutput);
  onPtyOutputRef.current = onPtyOutput;

  // Reset per-session state when navigating between sids so stale events
  // from the previous session's EventSource don't leak into this view.
  useEffect(() => {
    setEvents([]);
    setResolutions(new Map());
    setYoloMode(false);
    setAllowedTools(new Set());
    seenIds.current = new Set();
  }, [sid]);

  useEffect(() => {
    const ingest = (evt: EnvelopeEvent) => {
      // pty_output is the raw, high-volume terminal byte stream (PTY mode's
      // break-glass surface). Handle it before the seenIds dedupe: it is never
      // replayed (not persisted to JSONL; the server honors Last-Event-Id), so
      // tracking each chunk's id would grow seenIds without bound. The bytes
      // bypass React state entirely and go straight to the terminal sink (if
      // mounted) — keeping them out of the events array, where they would both
      // trigger a re-render per chunk and render as junk UnknownRows.
      if (evt.type === "pty_output") {
        const p = evt.payload as { content?: unknown };
        if (typeof p.content === "string") onPtyOutputRef.current?.(p.content);
        return;
      }
      if (seenIds.current.has(evt.id)) return;
      seenIds.current.add(evt.id);
      setEvents((prev) => [...prev, evt]);
      if (evt.type === "permission_resolved") {
        const p = evt.payload as {
          request_id?: string;
          decision?: "allow" | "deny";
        };
        if (p.request_id && p.decision) {
          const requestId = p.request_id;
          const decision = p.decision;
          setResolutions((prev) => {
            if (prev.get(requestId) === decision) return prev;
            const next = new Map(prev);
            next.set(requestId, decision);
            return next;
          });
        }
      }
      if (evt.type === "yolo_mode_changed") {
        const p = evt.payload as { enabled?: unknown };
        if (typeof p.enabled === "boolean") setYoloMode(p.enabled);
      }
      if (evt.type === "tool_allowlisted") {
        const p = evt.payload as { tool_name?: unknown };
        if (typeof p.tool_name === "string") {
          const name = p.tool_name;
          setAllowedTools((prev) => {
            if (prev.has(name)) return prev;
            const next = new Set(prev);
            next.add(name);
            return next;
          });
        }
      }
    };

    if (!inMemory) {
      // Archived-on-disk session: no live stream, one-shot fetch. If the
      // /inbox reconnects later and learns the session is in-memory after
      // all (rare race at server startup), this effect re-runs and upgrades
      // to SSE.
      setStreamStatus("connecting");
      let cancelled = false;
      fetch(`/${encodeURIComponent(sid)}/events`)
        .then((r) => {
          if (!r.ok) throw new Error(`server returned ${r.status}`);
          return r.json() as Promise<{ events: EnvelopeEvent[] }>;
        })
        .then((data) => {
          if (cancelled) return;
          for (const evt of data.events) ingest(evt);
          setStreamStatus("disconnected");
        })
        .catch(() => {
          if (cancelled) return;
          setStreamStatus("disconnected");
        });
      return () => {
        cancelled = true;
      };
    }

    // Live in-memory session: a long-lived EventSource. The browser auto-retries
    // transient drops on its own, but it gives up permanently when the socket is
    // killed while the page is backgrounded — the common tablet case: the PWA
    // sleeps, the stream dies, and `onerror` leaves us stranded on whatever frame
    // last arrived (often a mid-turn "thinking" the turn-end `result` never came
    // to clear). The page then looks like a slow agent when the agent is idle.
    //
    // Fix: rebuild the stream whenever the page returns to the foreground and the
    // current source isn't OPEN. A fresh connection replays the JSONL, but every
    // already-seen event is dropped by the seenIds dedupe in ingest(), so the
    // only events that reach React state are the ones genuinely missed while the
    // stream was dead. That self-heals a frozen page without a manual reload.
    let current: EventSource | null = null;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      current?.close();
      setStreamStatus("connecting");
      const es = new EventSource(`/${encodeURIComponent(sid)}/stream`);
      current = es;
      es.onopen = () => setStreamStatus("connected");
      es.onerror = () => setStreamStatus("disconnected");
      es.onmessage = (e) => {
        try {
          ingest(JSON.parse(e.data) as EnvelopeEvent);
        } catch {
          // malformed frame; ignore
        }
      };
    };

    const reviveIfStale = () => {
      if (document.visibilityState !== "visible") return;
      // Only rebuild when the browser has actually given up (CLOSED) or there's
      // no source. A CONNECTING source is the browser's own retry/backoff in
      // flight after a transient drop — tearing it down on every focus event
      // would reset that backoff and could hammer the server. The failure we
      // target is the permanent give-up, which lands the source in CLOSED.
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
  }, [sid, inMemory]);

  return { events, streamStatus, resolutions, yoloMode, allowedTools };
}
