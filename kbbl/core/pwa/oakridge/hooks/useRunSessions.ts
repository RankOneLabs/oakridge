import { useQuery } from "@tanstack/react-query";
import { fetchRunSessions } from "../client";
import { useSessionInventorySeed } from "./useSessionInventorySeed";

/** Every agent session the run has opened, oldest first — one entry per attempt, not per unit. */
export function useRunSessions(runId: string, enabled = true) {
  useSessionInventorySeed(enabled);
  return useQuery({ queryKey: ["oakridge", "run", runId, "sessions"], queryFn: () => fetchRunSessions(runId), refetchInterval: 10_000, enabled });
}
