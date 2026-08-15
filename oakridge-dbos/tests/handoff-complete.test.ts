import { expect, test } from "bun:test";

import type { ArtifactRevision } from "../src/domain/artifacts";
import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { createHandoffCompleteApp, type HandoffCompleteDependencies } from "../src/http/handoff-complete";

const artifact: ArtifactRevision = {
  id: "build-artifact" as ArtifactId, chain_id: "build-artifact" as ArtifactId, run_id: "run-1" as WorkflowRunId,
  stage_instance_id: "build-stage" as StageInstanceId, execution_id: "build-execution" as ExecutionId, unit_id: "unit-1" as UnitId,
  output_name: "build_result", artifact_type: "dev.build_result", label: null, body: {}, version: 1, parent_artifact_id: null, lifecycle: { kind: "current" }, created_at: "2026-08-14T12:00:00Z",
};

const fixture = (state: "awaiting_external" | "awaiting_downstream" = "awaiting_external") => {
  const sent: Array<{ workflow_id: string; command: unknown; key: string }> = [];
  const dependencies: HandoffCompleteDependencies = {
    artifacts: { emit_revision: async () => ({ ok: true, value: { kind: "unchanged", artifact, superseded_artifact_id: null } }), withdraw: async () => ({ kind: "not_found", artifact_id: artifact.id }), mark_released: async () => ({ kind: "released", artifact }), find_by_id: async () => artifact, find_tip: async () => artifact, find_current: async () => artifact, list_chain: async () => [artifact] },
    contexts: { find_for_emit: async () => ({ run_id: artifact.run_id, stage_key: "build", operator_role: null, stage_instance_id: artifact.stage_instance_id, execution_id: artifact.execution_id, unit_id: artifact.unit_id, executor_type: "delegated_session", execution_workflow_id: "build-workflow", inputs: [], outputs: [{ name: "build_result", artifact_type: "dev.build_result", release: { kind: "handoff", downstream_role: "assessment", external_wait_kind: "github_review" } }] }) },
    get_handoff_state: async () => ({ status: state, artifact_id: artifact.id }),
    send_handoff_command: async (workflow_id, command, key) => { sent.push({ workflow_id, command, key }); },
  };
  return { app: createHandoffCompleteApp(dependencies), sent };
};

const complete = (app: ReturnType<typeof createHandoffCompleteApp>, external_kind = "github_review") => app.request("/handoffs/build-artifact/external-complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ external_kind, correlation_id: "pr-review-42", idempotency_key: "github-review-42" }) });

test("external completion releases the exact durable handoff wait idempotently", async () => {
  const subject = fixture();
  const response = await complete(subject.app);
  expect(response.status).toBe(202);
  expect(subject.sent).toEqual([{ workflow_id: "build-workflow:handoff:build-artifact", key: "github-review-42", command: { kind: "external_completed", external_kind: "github_review", correlation_id: "pr-review-42" } }]);
});

test("external completion rejects the wrong configured kind", async () => {
  const response = await complete(fixture().app, "deployment");
  expect(response.status).toBe(409);
});

test("external completion cannot arrive before downstream approval", async () => {
  const response = await complete(fixture("awaiting_downstream").app);
  expect(response.status).toBe(409);
});
