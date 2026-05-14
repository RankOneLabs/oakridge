import { useState, useEffect } from "react";

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

  useEffect(() => {
    let cancelled = false;

    function connect() {
      // Reuse the /safir-stream channel — kbbl emits build.* events on the
      // same per-artifact SSE stream for the build_brief target.
      const url = new URL("/safir-stream", window.location.href);
      url.searchParams.set("target_type", "build_brief");
      url.searchParams.set("target_id", briefId);

      const es = new EventSource(url.toString());
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
          if (!cancelled) onCompleted?.();
        } else if (evt === "build.failed") {
          setStatus("failed");
          setStderrTail(typeof data.stderr_tail === "string" ? data.stderr_tail : null);
        }
      });
      es.addEventListener("error", () => {
        es.close();
        if (!cancelled) setTimeout(connect, 2000);
      });

      return es;
    }

    const es = connect();

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [briefId]);

  return { status, stderrTail };
}
