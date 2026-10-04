import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchRun, selectIsDefinitiveRequestFailure, submitCohortRequest } from "../client";
import { randomUuid } from "../../lib/random-uuid";
export function useAbandonCohort(runId: string) {
  const client = useQueryClient();
  const deliveries = useRef(new Map<string, Parameters<typeof submitCohortRequest>[0]>());
  return useMutation({ mutationFn: async ({ cohortId, detail }: { readonly cohortId: string; readonly detail: string }) => {
    const key = JSON.stringify({ cohortId, detail });
    const previous = deliveries.current.get(key);
    if (previous) return submitCohortRequest(previous);
    const run = await fetchRun(runId);
    const unit = run.stages.flatMap((stage) => stage.units ?? []).find((unit) => unit.cohort_id === cohortId);
    if (!unit) throw new Error("Cohort is missing");
    const envelope = { cohort_id: unit.cohort_id, expected_version: unit.version, id: randomUuid(), request: { kind: "abandon" as const, reason: detail } };
    deliveries.current.set(key, envelope);
    return submitCohortRequest(envelope);
  }, onError: (error, target) => {
    if (!selectIsDefinitiveRequestFailure(error)) return;
    deliveries.current.delete(JSON.stringify(target));
    void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
  }, onSuccess: (_result, target) => {
    deliveries.current.delete(JSON.stringify(target));
    void client.invalidateQueries({ queryKey: ["oakridge", "runs"] });
    void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
    void client.invalidateQueries({ queryKey: ["oakridge", "review-inbox"] });
  } });
}
