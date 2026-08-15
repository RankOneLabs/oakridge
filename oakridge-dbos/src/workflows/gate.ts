import { DBOS } from "@dbos-inc/dbos-sdk";

import type { ArtifactId, ExecutionId, StageInstanceId, UnitId } from "../domain/primitives";

export interface GateWaitInput {
  readonly stage_instance_id: StageInstanceId;
  readonly execution_id: ExecutionId;
  readonly unit_id: UnitId;
  readonly artifact_revision_id: ArtifactId;
  readonly gate_step: string;
  readonly actions: readonly string[];
}
export interface GateCommand { readonly action: string; readonly artifact_revision_id: ArtifactId; readonly gate_step: string }

export const durableGateWorkflow = DBOS.registerWorkflow(async (input: GateWaitInput): Promise<GateCommand> => {
  await DBOS.setEvent("gate-state", { status: "pending", ...input });
  for (;;) {
    const command = await DBOS.recv<GateCommand>("gate-command", { timeoutSeconds: 86_400 });
    if (!command) continue;
    if (command.artifact_revision_id !== input.artifact_revision_id || command.gate_step !== input.gate_step) continue;
    await DBOS.setEvent("gate-state", { status: "closed", action: command.action, ...input });
    return command;
  }
}, { name: "oakridgeDurableGateWorkflow" });
