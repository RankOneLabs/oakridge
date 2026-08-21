import { DBOS } from "@dbos-inc/dbos-sdk";

import type { ArtifactRevision } from "../domain/artifacts";
import type { ArtifactId } from "../domain/primitives";
import { selectBuiltInGateDisposition } from "../domain/gates";
import { closeWaitStep, openHandoffDownstreamWaitStep, releaseDownstreamWaitStep } from "./wait-record";

export interface HandoffWaitInput {
  readonly artifact: ArtifactRevision;
  readonly downstream_role: string;
  readonly external_wait_kind: string;
  readonly parent_workflow_id: string;
}

export type HandoffCommand =
  | { readonly kind: "downstream_decision"; readonly action: string; readonly decision_artifact_id: ArtifactId; readonly feedback: string | null }
  | { readonly kind: "external_completed"; readonly external_kind: string; readonly correlation_id: string }
  | { readonly kind: "supersede"; readonly replacement_artifact_revision_id: ArtifactId }
  | { readonly kind: "withdraw" };

export type HandoffResult =
  | { readonly kind: "released"; readonly artifact: ArtifactRevision; readonly decision_artifact_id: ArtifactId; readonly correlation_id: string }
  | { readonly kind: "revision_requested"; readonly artifact: ArtifactRevision; readonly decision_artifact_id: ArtifactId; readonly feedback: string | null }
  | { readonly kind: "superseded"; readonly artifact: ArtifactRevision; readonly replacement_artifact_revision_id: ArtifactId }
  | { readonly kind: "withdrawn"; readonly artifact: ArtifactRevision };

export const durableHandoffWorkflow = DBOS.registerWorkflow(async (input: HandoffWaitInput): Promise<HandoffResult> => {
  const commandWorkflowId = DBOS.workflowID;
  if (!commandWorkflowId) throw new Error("handoff workflow requires a workflow ID");
  await openHandoffDownstreamWaitStep({
    command_workflow_id: commandWorkflowId, stage_instance_id: input.artifact.stage_instance_id,
    unit_id: input.artifact.unit_id, artifact_revision_id: input.artifact.id,
    execution_workflow_id: input.parent_workflow_id, downstream_role: input.downstream_role,
  });
  for (;;) {
    const decision = await DBOS.recv<HandoffCommand>("handoff-command", { timeoutSeconds: 86_400 });
    if (!decision) continue;
    if (decision.kind === "supersede" || decision.kind === "withdraw") {
      const result: HandoffResult = decision.kind === "supersede"
        ? { kind: "superseded", artifact: input.artifact, replacement_artifact_revision_id: decision.replacement_artifact_revision_id }
        : { kind: "withdrawn", artifact: input.artifact };
      await closeWaitStep({
        command_workflow_id: commandWorkflowId, kind: "handoff_downstream",
        outcome: decision.kind === "supersede"
          ? { kind: "superseded", replacement_artifact_revision_id: decision.replacement_artifact_revision_id }
          : { kind: "withdrawn" },
      });
      return result;
    }
    if (decision.kind !== "downstream_decision") continue;
    // The decision was made against another stage's gate, so its step is not
    // in hand here; the shared vocabulary is.
    if (selectBuiltInGateDisposition(decision.action) !== "release") {
      const result: HandoffResult = { kind: "revision_requested", artifact: input.artifact, decision_artifact_id: decision.decision_artifact_id, feedback: decision.feedback };
      await closeWaitStep({
        command_workflow_id: commandWorkflowId, kind: "handoff_downstream",
        outcome: { kind: "decided", action: decision.action, decision_artifact_id: decision.decision_artifact_id, feedback: decision.feedback ?? null },
      });
      await DBOS.send(input.parent_workflow_id, { kind: "handoff_revision_requested", result }, "execution-event", `handoff:${input.artifact.id}:revision:${decision.decision_artifact_id}`);
      return result;
    }
    await releaseDownstreamWaitStep({
      command_workflow_id: commandWorkflowId,
      decided_outcome: { kind: "decided", action: decision.action, decision_artifact_id: decision.decision_artifact_id, feedback: decision.feedback ?? null },
      external_closes_on: { kind: "handoff_external", external_wait_kind: input.external_wait_kind, decision_artifact_id: decision.decision_artifact_id },
    });
    for (;;) {
      const external = await DBOS.recv<HandoffCommand>("handoff-command", { timeoutSeconds: 86_400 });
      if (!external) continue;
      if (external.kind === "supersede" || external.kind === "withdraw") {
        const result: HandoffResult = external.kind === "supersede"
          ? { kind: "superseded", artifact: input.artifact, replacement_artifact_revision_id: external.replacement_artifact_revision_id }
          : { kind: "withdrawn", artifact: input.artifact };
        await closeWaitStep({
          command_workflow_id: commandWorkflowId, kind: "handoff_external",
          outcome: external.kind === "supersede"
            ? { kind: "superseded", replacement_artifact_revision_id: external.replacement_artifact_revision_id }
            : { kind: "withdrawn" },
        });
        return result;
      }
      if (external.kind !== "external_completed" || external.external_kind !== input.external_wait_kind) continue;
      const result: HandoffResult = { kind: "released", artifact: input.artifact, decision_artifact_id: decision.decision_artifact_id, correlation_id: external.correlation_id };
      await closeWaitStep({
        command_workflow_id: commandWorkflowId, kind: "handoff_external",
        outcome: { kind: "external_completed", correlation_id: external.correlation_id },
      });
      await DBOS.send(input.parent_workflow_id, { kind: "artifact_released", artifact: input.artifact }, "execution-event", `handoff:${input.artifact.id}:released:${external.correlation_id}`);
      return result;
    }
  }
}, { name: "oakridgeDurableHandoffWorkflow" });
