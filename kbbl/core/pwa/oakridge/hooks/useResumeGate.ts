import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { resumeGate } from "../client";
import type { GateResumeRequest } from "../artifact-types";

/** Everything a gate decision can change: the gate lists, the inbox, the runs, and the decided run's units and sessions. */
export function invalidateGateQueries(client: QueryClient, runId: string | null) {
  void client.invalidateQueries({ queryKey: ["oakridge", "gates"] });
  void client.invalidateQueries({ queryKey: ["oakridge", "review-inbox"] });
  void client.invalidateQueries({ queryKey: ["oakridge", "runs"] });
  if (!runId) return;
  void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
  void client.invalidateQueries({ queryKey: ["oakridge", "run", runId, "gates"] });
  void client.invalidateQueries({ queryKey: ["oakridge", "run", runId, "sessions"] });
}

export function useResumeGate(gateId: string, runId: string | null) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (request: GateResumeRequest) => resumeGate(gateId, request), onSuccess: () => invalidateGateQueries(client, runId) });
}
