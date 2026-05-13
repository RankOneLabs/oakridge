import { useState, useEffect, useRef } from "react";
import type { ArtifactTarget, CommentThread, AtomEditRecord } from "./types";

/** Wire format emitted by GET /safir-stream SSE. */
export interface WireEvent {
  event: string;
  data: Record<string, unknown>;
  ts?: string;
}

export interface ArtifactStreamState {
  atomMap: Record<string, string>;
  threads: CommentThread[];
  status: string | null;
  lastEvent: WireEvent | null;
}

export function useArtifactStream(target: ArtifactTarget): ArtifactStreamState {
  const [atomMap, setAtomMap] = useState<Record<string, string>>({});
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<WireEvent | null>(null);
  const lastEventIdRef = useRef<string | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;

    async function init() {
      try {
        const [atomRes, threadRes] = await Promise.all([
          fetch(`/safir/atoms/${encodeURIComponent(target.type)}/${encodeURIComponent(target.id)}`),
          fetch(`/safir/artifacts/${encodeURIComponent(target.type)}/${encodeURIComponent(target.id)}/threads`),
        ]);
        if (cancelled) return;
        if (atomRes.ok) setAtomMap((await atomRes.json()) as Record<string, string>);
        if (threadRes.ok) setThreads((await threadRes.json()) as CommentThread[]);
      } catch {
        // best-effort; SSE will carry updates
      }

      if (cancelled) return;

      function connect() {
        const url = new URL("/safir-stream", window.location.href);
        url.searchParams.set("target_type", target.type);
        url.searchParams.set("target_id", target.id);
        if (lastEventIdRef.current) url.searchParams.set("last_event_id", lastEventIdRef.current);

        es = new EventSource(url.toString());
        es.addEventListener("message", (e) => {
          if (cancelled) return;
          lastEventIdRef.current = e.lastEventId || null;
          let parsed: WireEvent;
          try {
            parsed = JSON.parse(e.data as string) as WireEvent;
          } catch { return; }
          setLastEvent(parsed);
          applyEvent(parsed);
        });
        es.addEventListener("error", () => {
          if (cancelled) return;
          es?.close();
          // reconnect after brief delay; browser will honor Last-Event-Id on next open
          setTimeout(() => { if (!cancelled) connect(); }, 2000);
        });
      }

      connect();
    }

    function upsertThread(t: CommentThread) {
      if (!cancelled) {
        setThreads((prev) => {
          const idx = prev.findIndex((th) => th.id === t.id);
          return idx === -1 ? [...prev, t] : prev.map((th) => th.id === t.id ? t : th);
        });
      }
    }

    function applyEvent(evt: WireEvent) {
      const { event: e, data } = evt;
      if (e === "atom_edit.applied") {
        const anchor = typeof data.anchor === "string" ? data.anchor : null;
        const newValue = typeof data.new_value === "string" ? data.new_value : null;
        if (anchor !== null && newValue !== null) {
          setAtomMap((prev) => ({ ...prev, [anchor]: newValue }));
        }
      } else if (
        e === "comment_thread.created" ||
        e === "thread.message_added" ||
        e === "thread.status_changed" ||
        e === "thread.agent_response_completed" ||
        e === "thread.agent_response_failed"
      ) {
        const threadId = typeof data.thread_id === "string" ? data.thread_id : null;
        if (!threadId) return;
        void fetch(`/safir/threads/${threadId}`)
          .then((r) => r.ok ? r.json() : null)
          .then((t) => { if (t) upsertThread(t as CommentThread); });
      } else if (e === "artifact.status_changed") {
        const s = typeof data.status === "string" ? data.status : null;
        if (s) setStatus(s);
      } else if (e === "artifact.reopened") {
        setStatus("pending_approval");
      }
    }

    void init();

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [target.type, target.id]);

  return { atomMap, threads, status, lastEvent };
}

export function filterHistoryByAnchor(
  history: AtomEditRecord[],
  anchor: string | null,
): AtomEditRecord[] {
  if (anchor === null) return history;
  return history.filter((r) => r.anchor === anchor);
}
