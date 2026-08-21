import { DBOS } from "@dbos-inc/dbos-sdk";

import type { ArtifactId, ExecutionId, StageInstanceId, UnitId } from "../domain/primitives";
import { closeWaitStep, openGateWaitStep } from "./wait-record";

export interface GateWaitInput {
  readonly stage_instance_id: StageInstanceId;
  readonly execution_id: ExecutionId;
  readonly unit_id: UnitId;
  readonly artifact_revision_id: ArtifactId;
  /** The execution attempt this gate belongs to — the relay copies its own
   *  `parent_workflow_id` when it builds this input. Carried rather than
   *  resolved by lookup: the projection's execution workflow id is mutable
   *  under `replace_execution`; what the workflow was started with cannot
   *  drift. */
  readonly execution_workflow_id: string;
  readonly gate_step: string;
  readonly actions: readonly string[];
}
export type GateCommand =
  | { readonly kind: "decision"; readonly action: string; readonly artifact_revision_id: ArtifactId; readonly gate_step: string }
  | { readonly kind: "supersede"; readonly replacement_artifact_revision_id: ArtifactId }
  | { readonly kind: "withdraw" };

export type GateResult =
  | Extract<GateCommand, { readonly kind: "decision" }>
  | Extract<GateCommand, { readonly kind: "supersede" | "withdraw" }>;

export const durableGateWorkflow = DBOS.registerWorkflow(async (input: GateWaitInput): Promise<GateResult> => {
  const commandWorkflowId = DBOS.workflowID;
  if (!commandWorkflowId) throw new Error("gate workflow requires a workflow ID");
  await openGateWaitStep({
    command_workflow_id: commandWorkflowId, stage_instance_id: input.stage_instance_id, unit_id: input.unit_id,
    artifact_revision_id: input.artifact_revision_id, execution_workflow_id: input.execution_workflow_id,
    gate_step: input.gate_step, actions: input.actions,
  });
  for (;;) {
    const command = await DBOS.recv<GateCommand>("gate-command", { timeoutSeconds: 86_400 });
    if (!command) continue;
    if (command.kind !== "decision") {
      await closeWaitStep({
        command_workflow_id: commandWorkflowId, kind: "gate",
        outcome: command.kind === "supersede"
          ? { kind: "superseded", replacement_artifact_revision_id: command.replacement_artifact_revision_id }
          : { kind: "withdrawn" },
      });
      return command;
    }
    if (command.artifact_revision_id !== input.artifact_revision_id || command.gate_step !== input.gate_step) continue;
    await closeWaitStep({
      command_workflow_id: commandWorkflowId, kind: "gate",
      outcome: { kind: "decided", action: command.action, decision_artifact_id: null, feedback: null },
    });
    return command;
  }
}, { name: "oakridgeDurableGateWorkflow" });
