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
export type GateCommand =
  | { readonly kind: "decision"; readonly action: string; readonly artifact_revision_id: ArtifactId; readonly gate_step: string }
  | { readonly kind: "supersede"; readonly replacement_artifact_revision_id: ArtifactId }
  | { readonly kind: "withdraw" };

export type GateResult =
  | Extract<GateCommand, { readonly kind: "decision" }>
  | Extract<GateCommand, { readonly kind: "supersede" | "withdraw" }>;

export const durableGateWorkflow = DBOS.registerWorkflow(async (input: GateWaitInput): Promise<GateResult> => {
  await DBOS.setEvent("gate-state", { status: "pending", ...input });
  for (;;) {
    const command = await DBOS.recv<GateCommand>("gate-command", { timeoutSeconds: 86_400 });
    if (!command) continue;
    if (command.kind !== "decision") {
      await DBOS.setEvent("gate-state", { status: command.kind === "supersede" ? "superseded" : "withdrawn", ...input, ...command });
      return command;
    }
    if (command.artifact_revision_id !== input.artifact_revision_id || command.gate_step !== input.gate_step) continue;
    await DBOS.setEvent("gate-state", { status: "closed", action: command.action, ...input });
    return command;
  }
}, { name: "oakridgeDurableGateWorkflow" });
