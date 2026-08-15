import { DBOS } from "@dbos-inc/dbos-sdk";

import type { MaterializedExecutionUnit } from "../domain/compiled-workflow";
import type { JsonValue, StageInstanceId, UnitId, WorkflowRunId } from "../domain/primitives";
import { stubExecutionWorkflow, stubStageWorkflow, type StubExecutionResult } from "./stub-topology";

type StageSignal = { readonly kind: "output_released"; readonly result: StubExecutionResult } | { readonly kind: "producer_closed" };
export interface DeliveryProofInput {
  readonly run_id: WorkflowRunId;
  readonly producer_stage_instance_id: StageInstanceId;
  readonly consumer_stage_instance_id: StageInstanceId;
  readonly units: readonly MaterializedExecutionUnit[];
}
export interface DeliveryProofResult { readonly incremental: readonly UnitId[]; readonly collected: readonly UnitId[] }

export const deliveryProofWorkflow = DBOS.registerWorkflow(async (input: DeliveryProofInput): Promise<DeliveryProofResult> => {
  const rootWorkflowId = DBOS.workflowID;
  if (!rootWorkflowId) throw new Error("delivery proof requires workflow context");
  const producer = await DBOS.startWorkflow(stubStageWorkflow, { workflowID: `${rootWorkflowId}:producer` })({
    run_id: input.run_id,
    stage_instance_id: input.producer_stage_instance_id,
    units: input.units,
    max_parallel: input.units.length || 1,
    manually_admitted: input.units.map((unit) => unit.unit_id),
    signal_workflow_id: rootWorkflowId,
  });
  const incrementalHandles = [];
  let isClosed = false;
  while (!isClosed) {
    const signal = await DBOS.recv<StageSignal>("stage-signal", { timeoutSeconds: 60 });
    if (!signal) throw new Error("timed out waiting for producer signal");
    if (signal.kind === "producer_closed") {
      isClosed = true;
      continue;
    }
    const unit: MaterializedExecutionUnit = { unit_id: signal.result.unit_id, depends_on: [], parameters: signal.result.artifact };
    incrementalHandles.push(await DBOS.startWorkflow(stubExecutionWorkflow, { workflowID: `${rootWorkflowId}:incremental:${unit.unit_id}` })({
      run_id: input.run_id,
      stage_instance_id: input.consumer_stage_instance_id,
      unit,
    }));
  }
  const producerResult = await producer.getResult();
  const completedIncremental = await DBOS.waitAll(incrementalHandles);
  const incremental: UnitId[] = [];
  for (const handle of completedIncremental) incremental.push((await handle.getResult()).unit_id);
  const collected: UnitId[] = producerResult.results.map((result) => result.unit_id);
  const collectionPayload: JsonValue = collected;
  const collector = await DBOS.startWorkflow(stubExecutionWorkflow, { workflowID: `${rootWorkflowId}:collector` })({
    run_id: input.run_id,
    stage_instance_id: input.consumer_stage_instance_id,
    unit: { unit_id: "collection" as UnitId, depends_on: [], parameters: collectionPayload },
  });
  await collector.getResult();
  return { incremental, collected };
}, { name: "oakridgeDeliveryProofWorkflow" });
