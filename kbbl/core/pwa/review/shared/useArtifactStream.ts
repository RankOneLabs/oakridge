import { useState, useEffect, useRef } from "react";
import type { ArtifactTarget, ArtifactStreamEvent, CommentThread, AtomEditRecord } from "./types";

export interface ArtifactStreamState {
  atomMap: Record<string, string>;
  threads: CommentThread[];
  status: string | null;
  lastEvent: ArtifactStreamEvent | null;
}

export function useArtifactStream(target: ArtifactTarget): ArtifactStreamState {
  const [atomMap, setAtomMap] = useState<Record<string, string>>({});
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<ArtifactStreamEvent | null>(null);
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
          let parsed: ArtifactStreamEvent;
          try {
            parsed = JSON.parse(e.data as string) as ArtifactStreamEvent;
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

    function applyEvent(evt: ArtifactStreamEvent) {
      if (evt.type === "atom_edit") {
        setAtomMap((prev) => ({ ...prev, [evt.anchor]: evt.new_value }));
        // refresh threads that reference this edit
      } else if (evt.type === "thread") {
        if (evt.event === "created") {
          // fetch new thread and append
          void fetch(`/safir/threads/${(evt.data as { thread_id?: string }).thread_id ?? ""}`)
            .then((r) => r.ok ? r.json() : null)
            .then((t) => { if (t && !cancelled) setThreads((prev) => [...prev, t as CommentThread]); });
        } else {
          const threadId = (evt.data as { thread_id?: string }).thread_id;
          if (!threadId) return;
          void fetch(`/safir/threads/${threadId}`)
            .then((r) => r.ok ? r.json() : null)
            .then((t) => {
              if (t && !cancelled) {
                setThreads((prev) => prev.map((th) => th.id === threadId ? (t as CommentThread) : th));
              }
            });
        }
      } else if (evt.type === "status") {
        setStatus(evt.status);
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
