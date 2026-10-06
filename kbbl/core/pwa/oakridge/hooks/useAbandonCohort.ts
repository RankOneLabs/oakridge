import { deliverCohortRequest } from "../lib/cohort-request-delivery";
import { isDefinitiveRequestRejection, OakridgeHttpError } from "../lib/client-errors";
import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchRun, submitCohortRequest } from "../client";
import { randomUuid } from "../../lib/random-uuid";
export function useAbandonCohort(runId: string) {
  const client = useQueryClient();
  const deliveries = useRef(new Map<string, Parameters<typeof submitCohortRequest>[0]>());
  return useMutation({ mutationFn: async ({ cohortId, detail, observedVersion }: { readonly cohortId: string; readonly detail: string; readonly observedVersion: number }) => {
    const key = JSON.stringify({ cohortId, detail, observedVersion });
    return deliverCohortRequest({ retained: deliveries.current, key, submit: submitCohortRequest, load: async () => {
      const run = await fetchRun(runId);
      const unit = run.stages.flatMap((stage) => stage.units ?? []).find((unit) => unit.cohort_id === cohortId);
      if (!unit) throw new Error("Cohort is missing");
      if (unit.version !== observedVersion)
        throw new OakridgeHttpError(409, "Cohort changed since this abandon action was shown. Refresh and review it again.");
      const envelope = { cohort_id: unit.cohort_id, expected_version: observedVersion, id: randomUuid(), request: { kind: "abandon" as const, reason: detail } };
      return envelope;
    } });
  }, onError: (cause) => {
    if (!isDefinitiveRequestRejection(cause)) return;
    void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
  }, onSuccess: () => {
    void client.invalidateQueries({ queryKey: ["oakridge", "runs"] });
    void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
    void client.invalidateQueries({ queryKey: ["oakridge", "review-inbox"] });
  } });
}
