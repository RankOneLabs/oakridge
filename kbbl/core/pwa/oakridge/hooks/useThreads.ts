import { useQuery } from "@tanstack/react-query";
import { fetchSessionMessages, fetchThreads } from "../client";
export function useThreads(artifactId: string, enabled = true) { return useQuery({ queryKey: ["oakridge", "artifact", artifactId, "threads"], queryFn: () => fetchThreads(artifactId), refetchInterval: 10_000, enabled }); }

export function useSessionMessages(runId: string, cohortId?: string, enabled = true) {
  return useQuery({
    queryKey: ["oakridge", "run", runId, "messages", cohortId ?? null],
    queryFn: () => fetchSessionMessages(runId, cohortId),
    refetchInterval: 10_000,
    enabled,
  });
}
