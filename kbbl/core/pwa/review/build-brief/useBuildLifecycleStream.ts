import { useState, useEffect, useRef } from "react";

export type BuildLifecycleStatus =
  | "idle"
  | "building"
  | "completed"
  | "failed";

export interface BuildLifecycleState {
  status: BuildLifecycleStatus;
  stderrTail: string | null;
}

/** Subscribe to kbbl SSE build lifecycle events for a specific brief. */
export function useBuildLifecycleStream(
  briefId: string,
  onCompleted?: () => void,
): BuildLifecycleState {
  const [status, setStatus] = useState<BuildLifecycleStatus>("idle");
  const [stderrTail, setStderrTail] = useState<string | null>(null);

  // Keep a stable ref to the latest onCompleted so the effect closure never
  // goes stale without needing to re-run the effect.
  const onCompletedRef = useRef(onCompleted);
  useEffect(() => { onCompletedRef.current = onCompleted; }, [onCompleted]);

  useEffect(() => {
    let cancelled = false;
    // Track the active EventSource and any pending reconnect timer so cleanup
    // closes the right connection.
    const esRef = { current: null as EventSource | null };
    const timerRef = { current: null as ReturnType<typeof setTimeout> | null };

    function connect() {
      const url = new URL("/safir-stream", window.location.href);
      url.searchParams.set("target_type", "build_brief");
      url.searchParams.set("target_id", briefId);

      const es = new EventSource(url.toString());
      esRef.current = es;

      es.addEventListener("message", (e) => {
        if (cancelled) return;
        let parsed: { event: string; data: Record<string, unknown> };
        try {
          parsed = JSON.parse(e.data as string) as typeof parsed;
        } catch { return; }

        const { event: evt, data } = parsed;
        if (typeof data.brief_id === "string" && data.brief_id !== briefId) return;

        if (evt === "build.started") {
          setStatus("building");
        } else if (evt === "build.completed") {
          setStatus("completed");
          setStderrTail(null);
          if (!cancelled) onCompletedRef.current?.();
        } else if (evt === "build.failed") {
          setStatus("failed");
          setStderrTail(typeof data.stderr_tail === "string" ? data.stderr_tail : null);
        }
      });
      es.addEventListener("error", () => {
        es.close();
        esRef.current = null;
        if (!cancelled) {
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            if (!cancelled) connect();
          }, 2000);
        }
      });
    }

    connect();

    return () => {
      cancelled = true;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      esRef.current?.close();
    };
  }, [briefId]);

  return { status, stderrTail };
}
