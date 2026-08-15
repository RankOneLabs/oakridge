import { DBOS } from "@dbos-inc/dbos-sdk";

import { selectReadyUnits } from "../compiler/materialize-units";
import type { MaterializedExecutionUnit } from "../domain/compiled-workflow";
import type { JsonValue, StageInstanceId, UnitId, WorkflowRunId } from "../domain/primitives";

export interface StubExecutionInput {
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly unit: MaterializedExecutionUnit;
}
export interface StubExecutionResult { readonly unit_id: UnitId; readonly artifact: JsonValue }
export interface StubStageInput {
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly units: readonly MaterializedExecutionUnit[];
  readonly max_parallel: number;
  readonly manually_admitted: readonly UnitId[];
  readonly signal_workflow_id?: string;
}
export interface StubStageResult { readonly results: readonly StubExecutionResult[] }

const stubExecutorStep = DBOS.registerStep(
  async (input: StubExecutionInput): Promise<StubExecutionResult> => {
    const parameters = input.unit.parameters;
    const delay = !Array.isArray(parameters) && parameters !== null && typeof parameters === "object"
      ? (parameters as { readonly delay_ms?: JsonValue }).delay_ms
      : undefined;
    if (typeof delay === "number" && delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    return { unit_id: input.unit.unit_id, artifact: { unit_id: input.unit.unit_id, parameters } };
  },
  { name: "oakridgeStubExecutor" },
);

export const stubExecutionWorkflow = DBOS.registerWorkflow(
  async (input: StubExecutionInput): Promise<StubExecutionResult> => stubExecutorStep(input),
  { name: "oakridgeStubExecutionWorkflow" },
);

export const stubStageWorkflow = DBOS.registerWorkflow(
  async (input: StubStageInput): Promise<StubStageResult> => {
    const released = new Set<UnitId>();
    const admitted = new Set(input.manually_admitted);
    const results: StubExecutionResult[] = [];
    while (released.size < input.units.length) {
      const ready = selectReadyUnits(input.units, released, admitted, new Set(), input.max_parallel);
      if (ready.length === 0) throw new Error("stage has unfinished units but no dependency-ready admitted work");
      const handles = [];
      for (const unit of ready) {
        handles.push(await DBOS.startWorkflow(stubExecutionWorkflow, {
          workflowID: `${input.stage_instance_id}:unit:${unit.unit_id}`,
        })({ run_id: input.run_id, stage_instance_id: input.stage_instance_id, unit }));
      }
      const completedHandles = await DBOS.waitAll(handles);
      for (const handle of completedHandles) {
        const result = await handle.getResult();
        results.push(result);
        released.add(result.unit_id);
        if (input.signal_workflow_id) await DBOS.send(input.signal_workflow_id, { kind: "output_released", result } as const, "stage-signal");
      }
    }
    if (input.signal_workflow_id) await DBOS.send(input.signal_workflow_id, { kind: "producer_closed" } as const, "stage-signal");
    return { results };
  },
  { name: "oakridgeStubStageWorkflow" },
);
