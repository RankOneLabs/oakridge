import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { AtomEdit, Thread } from "./types";

export interface ArtifactStreamState {
  edits: AtomEdit[];
  threads: Thread[];
  status: "idle" | "connected" | "reconnecting";
  frozen: boolean;
}

type ThreadDelta =
  | { type: "created"; thread: Omit<Thread, "status"> }
  | { type: "resolved"; id: string };

// Mounts the artifact stream: three seed queries (atoms/edits, threads,
// review/frozen) plus a long-lived /artifact-stream EventSource. The
// EventSource pushes deltas into local accumulators which are merged onto
// the seed data via useMemo.
//
// Pattern intentionally mirrors useInbox: cache holds the snapshot, SSE
// holds the deltas, render combines them. Mutations (useDirectEdit) can
// invalidate the seed key to force a refetch when needed.
export function useArtifactStream(
  target_type: string,
  target_id: string,
): ArtifactStreamState {
  const qs = useMemo(
    () => new URLSearchParams({ target_type, target_id }).toString(),
    [target_type, target_id],
  );

  const editsQuery = useQuery({
    queryKey: ["atoms", "edits", { target_type, target_id }],
    queryFn: async (): Promise<AtomEdit[]> => {
      const res = await fetch(`/atoms/edits?${qs}`);
      if (!res.ok) return [];
      return (await res.json()) as AtomEdit[];
    },
  });
  const threadsQuery = useQuery({
    queryKey: ["threads", { target_type, target_id }],
    queryFn: async (): Promise<Thread[]> => {
      const res = await fetch(`/threads?${qs}`);
      if (!res.ok) return [];
      return (await res.json()) as Thread[];
    },
  });
  const frozenQuery = useQuery({
    queryKey: ["review", "frozen", { target_type, target_id }],
    queryFn: async (): Promise<{ frozen: boolean }> => {
      const res = await fetch(`/review/frozen?${qs}`);
      if (!res.ok) return { frozen: false };
      return (await res.json()) as { frozen: boolean };
    },
  });

  const [editsDeltas, setEditsDeltas] = useState<AtomEdit[]>([]);
  const [threadDeltas, setThreadDeltas] = useState<ThreadDelta[]>([]);
  const [frozenOverride, setFrozenOverride] = useState<boolean | null>(null);
  const [status, setStatus] = useState<"idle" | "connected" | "reconnecting">(
    "idle",
  );

  // Reset accumulators when the artifact identity changes — otherwise a
  // route change from plan A to plan B would render plan B with plan A's
  // deltas on top.
  useEffect(() => {
    setEditsDeltas([]);
    setThreadDeltas([]);
    setFrozenOverride(null);
    setStatus("idle");
  }, [target_type, target_id]);

  useEffect(() => {
    const es = new EventSource(`/artifact-stream?${qs}`);

    es.onopen = () => setStatus("connected");
    es.onerror = () => setStatus("reconnecting");

    es.addEventListener("atom_edit.applied", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as AtomEdit;
      if (data.target_type !== target_type || data.target_id !== target_id)
        return;
      setEditsDeltas((prev) => [...prev, data]);
    });

    es.addEventListener("thread.created", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as Omit<
        Thread,
        "status"
      >;
      if (data.target_type !== target_type || data.target_id !== target_id)
        return;
      setThreadDeltas((prev) => [...prev, { type: "created", thread: data }]);
    });

    es.addEventListener("thread.resolved", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        id: string;
        target_type: string;
        target_id: string;
      };
      if (data.target_type !== target_type || data.target_id !== target_id)
        return;
      setThreadDeltas((prev) => [...prev, { type: "resolved", id: data.id }]);
    });

    es.addEventListener("artifact.frozen", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        target_type: string;
        target_id: string;
      };
      if (data.target_type !== target_type || data.target_id !== target_id)
        return;
      setFrozenOverride(true);
    });

    es.addEventListener("artifact.reopened", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        target_type: string;
        target_id: string;
      };
      if (data.target_type !== target_type || data.target_id !== target_id)
        return;
      setFrozenOverride(false);
    });

    return () => {
      es.close();
    };
  }, [target_type, target_id, qs]);

  const edits = useMemo(
    () => [...(editsQuery.data ?? []), ...editsDeltas],
    [editsQuery.data, editsDeltas],
  );
  const threads = useMemo(
    () => mergeThreads(threadsQuery.data ?? [], threadDeltas),
    [threadsQuery.data, threadDeltas],
  );
  const frozen = frozenOverride ?? frozenQuery.data?.frozen ?? false;

  return { edits, threads, status, frozen };
}

function mergeThreads(seed: Thread[], deltas: ThreadDelta[]): Thread[] {
  const result = [...seed];
  for (const d of deltas) {
    if (d.type === "created") {
      // De-dupe in case the SSE replay overlaps the seed fetch.
      if (!result.some((t) => t.id === d.thread.id)) {
        result.push({ ...d.thread, status: "open" });
      }
    } else if (d.type === "resolved") {
      const idx = result.findIndex((t) => t.id === d.id);
      if (idx >= 0) result[idx] = { ...result[idx], status: "resolved" };
    }
  }
  return result;
}
