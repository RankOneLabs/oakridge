import { useState, useEffect } from "react";
import type { AtomEdit, Thread } from "./types";

export interface ArtifactStreamState {
  edits: AtomEdit[];
  threads: Thread[];
  status: "idle" | "connected" | "reconnecting";
  frozen: boolean;
}

export function useArtifactStream(
  target_type: string,
  target_id: string,
): ArtifactStreamState {
  const [state, setState] = useState<ArtifactStreamState>({
    edits: [],
    threads: [],
    status: "idle",
    frozen: false,
  });

  useEffect(() => {
    let cancelled = false;

    const qs = (p: Record<string, string>) =>
      new URLSearchParams(p).toString();

    // Fetch initial state: edits, threads, and frozen status in parallel.
    Promise.all([
      fetch(`/atoms/edits?${qs({ target_type, target_id })}`).then(
        (r) => r.json() as Promise<AtomEdit[]>,
      ),
      fetch(`/threads?${qs({ target_type, target_id })}`).then(
        (r) => r.json() as Promise<Thread[]>,
      ),
      fetch(`/review/frozen?${qs({ target_type, target_id })}`).then(
        (r) => r.json() as Promise<{ frozen: boolean }>,
      ),
    ])
      .then(([edits, threads, frozenData]) => {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          edits,
          threads,
          frozen: frozenData.frozen,
        }));
      })
      .catch(() => {
        // network error; SSE still provides live updates
      });

    const es = new EventSource(
      `/safir-stream?${qs({ target_type, target_id })}`,
    );

    es.onopen = () => {
      if (!cancelled) setState((prev) => ({ ...prev, status: "connected" }));
    };
    es.onerror = () => {
      if (!cancelled)
        setState((prev) => ({ ...prev, status: "reconnecting" }));
    };

    es.addEventListener("atom_edit.applied", (e) => {
      if (cancelled) return;
      const data = JSON.parse((e as MessageEvent).data) as AtomEdit;
      if (data.target_type !== target_type || data.target_id !== target_id)
        return;
      setState((prev) => ({ ...prev, edits: [...prev.edits, data] }));
    });

    es.addEventListener("thread.created", (e) => {
      if (cancelled) return;
      const data = JSON.parse((e as MessageEvent).data) as Omit<
        Thread,
        "status"
      >;
      if (data.target_type !== target_type || data.target_id !== target_id)
        return;
      setState((prev) => ({
        ...prev,
        threads: [...prev.threads, { ...data, status: "open" as const }],
      }));
    });

    es.addEventListener("thread.resolved", (e) => {
      if (cancelled) return;
      const data = JSON.parse((e as MessageEvent).data) as {
        id: string;
        target_type: string;
        target_id: string;
      };
      if (data.target_type !== target_type || data.target_id !== target_id)
        return;
      setState((prev) => ({
        ...prev,
        threads: prev.threads.map((t) =>
          t.id === data.id ? { ...t, status: "resolved" as const } : t,
        ),
      }));
    });

    es.addEventListener("artifact.frozen", (e) => {
      if (cancelled) return;
      const data = JSON.parse((e as MessageEvent).data) as {
        target_type: string;
        target_id: string;
      };
      if (data.target_type !== target_type || data.target_id !== target_id)
        return;
      setState((prev) => ({ ...prev, frozen: true }));
    });

    es.addEventListener("artifact.reopened", (e) => {
      if (cancelled) return;
      const data = JSON.parse((e as MessageEvent).data) as {
        target_type: string;
        target_id: string;
      };
      if (data.target_type !== target_type || data.target_id !== target_id)
        return;
      setState((prev) => ({ ...prev, frozen: false }));
    });

    return () => {
      cancelled = true;
      es.close();
    };
  }, [target_type, target_id]);

  return state;
}
