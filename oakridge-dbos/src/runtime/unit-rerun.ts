import type { StageRerunState } from "../domain/rerun";
import type { StageInstanceId, UnitId } from "../domain/primitives";
import type { RerunTargetRepository } from "../storage/repositories";
import type { StageCommand } from "../workflows/production-topology";

export interface RerunWorkflowStatus { readonly workflowID: string; readonly forkedFrom?: string }
export interface RerunDbosClient {
  forkWorkflow(workflow_id: string, start_step: number, options: { readonly newWorkflowID: string; readonly applicationVersion?: string }): Promise<string>;
  getWorkflow(workflow_id: string): Promise<RerunWorkflowStatus | undefined>;
  getEvent<Value>(workflow_id: string, key: string, options: { readonly timeoutSeconds: number }): Promise<Value | null>;
  send(destination_id: string, message: unknown, topic?: string, idempotency_key?: string): Promise<void>;
}

export interface UnitRerunRequest {
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: UnitId;
  readonly rerun_id: string;
  readonly application_version?: string;
}

export interface UnitRerunResult { readonly replacement_execution_workflow_id: string }

export const rerunUnit = async (request: UnitRerunRequest, targets: RerunTargetRepository, dbos: RerunDbosClient): Promise<UnitRerunResult> => {
  const target = await targets.find_unit_target(request.stage_instance_id, request.unit_id);
  if (!target) throw new Error(`execution unit '${request.stage_instance_id}:${request.unit_id}' was not found`);
  const replacementId = `oakridge-unit-rerun:${request.stage_instance_id}:${request.unit_id}:${request.rerun_id}`;
  const state = await dbos.getEvent<StageRerunState>(target.stage_coordinator_workflow_id, "stage-rerun-state", { timeoutSeconds: 0 });
  if (state?.status === "resumed" && state.unit_id === request.unit_id &&
      state.replacement_execution_workflow_id === replacementId && target.execution_workflow_id === replacementId) {
    return { replacement_execution_workflow_id: replacementId };
  }
  if (state?.status === "waiting" && state.unit_id === request.unit_id && target.execution_workflow_id === replacementId) {
    const replacement = await dbos.getWorkflow(replacementId);
    if (replacement?.forkedFrom === state.failed_execution_workflow_id) return { replacement_execution_workflow_id: replacementId };
    throw new Error(`rerun workflow ID '${replacementId}' does not match the waiting execution`);
  }
  if (!state || state.status !== "waiting" || state.unit_id !== request.unit_id || state.failed_execution_workflow_id !== target.execution_workflow_id) {
    throw new Error(`execution unit '${request.stage_instance_id}:${request.unit_id}' is not waiting for rerun`);
  }
  const existing = await dbos.getWorkflow(replacementId);
  if (!existing) {
    await dbos.forkWorkflow(target.execution_workflow_id, 0, { newWorkflowID: replacementId, applicationVersion: request.application_version });
  } else if (existing.forkedFrom !== target.execution_workflow_id) {
    throw new Error(`rerun workflow ID '${replacementId}' belongs to another workflow`);
  }
  const command: StageCommand = { kind: "replace_execution", unit_id: request.unit_id,
    failed_execution_workflow_id: target.execution_workflow_id, replacement_execution_workflow_id: replacementId };
  await dbos.send(target.stage_coordinator_workflow_id, command, "stage-command", `rerun:${request.rerun_id}`);
  return { replacement_execution_workflow_id: replacementId };
};
