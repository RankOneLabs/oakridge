import { DBOS } from "@dbos-inc/dbos-sdk";

import type { ArtifactRevision } from "../domain/artifacts";

export interface HandoffWaitInput {
  readonly artifact: ArtifactRevision;
  readonly downstream_role: string;
  readonly external_wait_kind: string;
  readonly parent_workflow_id: string;
}

export type HandoffCommand =
  | { readonly kind: "downstream_decision"; readonly action: string; readonly decision_artifact_id: string; readonly feedback: string | null }
  | { readonly kind: "external_completed"; readonly external_kind: string; readonly correlation_id: string };

export type HandoffResult =
  | { readonly kind: "released"; readonly artifact: ArtifactRevision; readonly decision_artifact_id: string; readonly correlation_id: string }
  | { readonly kind: "revision_requested"; readonly artifact: ArtifactRevision; readonly decision_artifact_id: string; readonly feedback: string | null };

export const durableHandoffWorkflow = DBOS.registerWorkflow(async (input: HandoffWaitInput): Promise<HandoffResult> => {
  await DBOS.setEvent("handoff-state", { status: "awaiting_downstream", artifact_id: input.artifact.id, downstream_role: input.downstream_role });
  for (;;) {
    const decision = await DBOS.recv<HandoffCommand>("handoff-command", { timeoutSeconds: 86_400 });
    if (!decision || decision.kind !== "downstream_decision") continue;
    const isPass = decision.action === "pass" || decision.action === "approve" || decision.action === "confirm_merged" || decision.action === "closed_without_merge";
    if (!isPass) {
      const result: HandoffResult = { kind: "revision_requested", artifact: input.artifact, decision_artifact_id: decision.decision_artifact_id, feedback: decision.feedback };
      await DBOS.setEvent("handoff-state", { status: "revision_requested", artifact_id: input.artifact.id, decision_artifact_id: decision.decision_artifact_id });
      await DBOS.send(input.parent_workflow_id, { kind: "handoff_revision_requested", result }, "execution-event", `handoff:${input.artifact.id}:revision:${decision.decision_artifact_id}`);
      return result;
    }
    await DBOS.setEvent("handoff-state", { status: "awaiting_external", artifact_id: input.artifact.id, external_kind: input.external_wait_kind, decision_artifact_id: decision.decision_artifact_id });
    for (;;) {
      const external = await DBOS.recv<HandoffCommand>("handoff-command", { timeoutSeconds: 86_400 });
      if (!external || external.kind !== "external_completed" || external.external_kind !== input.external_wait_kind) continue;
      const result: HandoffResult = { kind: "released", artifact: input.artifact, decision_artifact_id: decision.decision_artifact_id, correlation_id: external.correlation_id };
      await DBOS.setEvent("handoff-state", { status: "released", artifact_id: input.artifact.id, external_kind: input.external_wait_kind, decision_artifact_id: decision.decision_artifact_id, correlation_id: external.correlation_id });
      await DBOS.send(input.parent_workflow_id, { kind: "artifact_released", artifact: input.artifact }, "execution-event", `handoff:${input.artifact.id}:released:${external.correlation_id}`);
      return result;
    }
  }
}, { name: "oakridgeDurableHandoffWorkflow" });
