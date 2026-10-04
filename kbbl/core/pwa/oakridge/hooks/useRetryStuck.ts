import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchRun, selectIsDefinitiveRequestFailure, submitCohortRequest } from "../client";
import { selectWorkerRetryRequest } from "../lib/worker-retry-request";
import { randomUuid } from "../../lib/random-uuid";
import type { V15WorkerKey } from "../../../../../oakridge-dbos/src/domain/dev-flow-v15";
export interface RetryUnitTarget { readonly stageInstanceId: string; readonly unitId: string; readonly worker?: V15WorkerKey }
export function useRetryStuck(runId: string) {
  const client = useQueryClient();
  const deliveries = useRef(new Map<string, Parameters<typeof submitCohortRequest>[0]>());
  return useMutation({ mutationFn: async (target: RetryUnitTarget) => {
    const key = JSON.stringify(target);
    const previous = deliveries.current.get(key);
    if (previous) return submitCohortRequest(previous);
    const run = await fetchRun(runId);
    const unit = run.stages.find((stage) => stage.stage_instance_id === target.stageInstanceId)?.units?.find((unit) => unit.unit_id === target.unitId);
    if (!unit) throw new Error("Cohort is missing");
    const interrupted = unit.workers.filter((worker) => worker.record.state === "interrupted" && (!target.worker || target.worker === worker.worker));
    if (interrupted.length !== 1) throw new Error("Select an interrupted worker to retry");
    const envelope = { cohort_id: unit.cohort_id, expected_version: unit.version, id: randomUuid(),
      request: selectWorkerRetryRequest(interrupted[0]!.worker) };
    deliveries.current.set(key, envelope);
    return submitCohortRequest(envelope);
  }, onError: (error, target) => {
    if (!selectIsDefinitiveRequestFailure(error)) return;
    deliveries.current.delete(JSON.stringify(target));
    void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
  }, onSuccess: (_result, target) => { deliveries.current.delete(JSON.stringify(target)); void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] }); } });
}
