import { deliverCohortRequest } from "../lib/cohort-request-delivery";
import { isDefinitiveRequestRejection } from "../lib/client-errors";
import { selectWorkerAttention } from "../../../../../oakridge-dbos/src/domain/worker-attention";
import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchRun, submitCohortRequest } from "../client";
import { selectWorkerRetryRequest } from "../lib/worker-retry-request";
import { randomUuid } from "../../lib/random-uuid";
import type { V15WorkerKey } from "../../../../../oakridge-dbos/src/domain/dev-flow-v15";
export interface RetryUnitTarget { readonly stageInstanceId: string; readonly unitId: string; readonly worker?: V15WorkerKey }
export function useRetryStuck(runId: string) {
  const client = useQueryClient();
  const deliveries = useRef(new Map<string, Parameters<typeof submitCohortRequest>[0]>());
  return useMutation({ mutationFn: async (target: RetryUnitTarget) => {
    const key = JSON.stringify(target);
    return deliverCohortRequest({ retained: deliveries.current, key, submit: submitCohortRequest, load: async () => {
      const run = await fetchRun(runId);
      const unit = run.stages.find((stage) => stage.stage_instance_id === target.stageInstanceId)?.units?.find((unit) => unit.unit_id === target.unitId);
      if (!unit) throw new Error("Cohort is missing");
      const interrupted = unit.workers.filter((worker) => selectWorkerAttention(worker).can_retry && (!target.worker || target.worker === worker.worker));
      if (interrupted.length !== 1) throw new Error("Select an interrupted worker to retry");
      const envelope = { cohort_id: unit.cohort_id, expected_version: unit.version, id: randomUuid(),
        request: selectWorkerRetryRequest(interrupted[0]!.worker) };
      return envelope;
    } });
  }, onError: (cause) => {
    if (!isDefinitiveRequestRejection(cause)) return;
    void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
  }, onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] }); } });
}
