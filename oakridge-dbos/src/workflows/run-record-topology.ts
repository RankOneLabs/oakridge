import type { Command } from "../decision/commands";
import { cohortMachineWorkflowId, runMachineWorkflowId, stageMachineWorkflowId } from "../decision/ids";
import type { CohortId, StageInstanceId, WorkflowRunId } from "../domain/primitives";
import type { TransitionOwner } from "../domain/run-record";

export interface DecisionMachineAddress {
  readonly owner: TransitionOwner;
  readonly workflow_id: string;
}

export const runMachineAddress = (run_id: WorkflowRunId): DecisionMachineAddress => ({
  owner: { kind: "run", id: run_id },
  workflow_id: runMachineWorkflowId(run_id),
});

export const stageMachineAddress = (stage_instance_id: StageInstanceId): DecisionMachineAddress => ({
  owner: { kind: "stage_instance", id: stage_instance_id },
  workflow_id: stageMachineWorkflowId(stage_instance_id),
});

export const cohortMachineAddress = (cohort_id: CohortId): DecisionMachineAddress => ({
  owner: { kind: "cohort", id: cohort_id },
  workflow_id: cohortMachineWorkflowId(cohort_id),
});

/** A command is routed only to the machine that owns its optimistic version. */
export const machineAddressFor = (command: Command): DecisionMachineAddress => {
  if (command.kind === "transition_run") return runMachineAddress(command.run_id);
  if (command.kind === "transition_stage") return stageMachineAddress(command.stage_instance_id);
  return cohortMachineAddress(command.cohort_id);
};
