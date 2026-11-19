import { useMutation, useQueryClient } from "@tanstack/react-query";
import { resumeGate } from "../client";
import type { GateResumeRequest } from "../artifact-types";
import type { Result } from "../../lib/result";
import { invalidateGateQueries } from "./useResumeGate";

export interface GateResumeTarget { readonly gate_id: string; readonly request: GateResumeRequest }
export type GateResumeOutcome = { readonly gate_id: string } & Result<null, string>;

/**
 * One decision sent to several gates, one request each, in order. Each gate's outcome is
 * reported on its own, so a refusal on one unit leaves the others decided and can be retried alone.
 */
export function useResumeGates(runId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (targets: readonly GateResumeTarget[]): Promise<readonly GateResumeOutcome[]> => {
      const outcomes: GateResumeOutcome[] = [];
      for (const target of targets) {
        try {
          await resumeGate(target.gate_id, target.request);
          outcomes.push({ gate_id: target.gate_id, ok: true, value: null });
        } catch (error) {
          outcomes.push({ gate_id: target.gate_id, ok: false, error: error instanceof Error ? error.message : "Could not send answer." });
        }
      }
      return outcomes;
    },
    onSettled: () => invalidateGateQueries(client, runId),
  });
}
