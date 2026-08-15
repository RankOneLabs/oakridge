import { expect, test } from "bun:test";

import { createArtifactCallbackApp, type ArtifactWorkflowMessage } from "../src/http/artifact-callback";
import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import type { ArtifactRevisionRepository, ExecutionArtifactContextRepository } from "../src/storage/repositories";

const stageId = "stage-1" as StageInstanceId;
const unitId = "unit-1" as UnitId;
const contexts: ExecutionArtifactContextRepository = { find_for_emit: async () => ({ run_id: "run-1" as WorkflowRunId, stage_key: "build", operator_role: null, stage_instance_id: stageId, execution_id: "execution-1" as ExecutionId, unit_id: unitId, executor_type: "delegated_session", execution_workflow_id: "execution-workflow-1", inputs: [], outputs: [{ name: "result", artifact_type: "dev.result", release: { kind: "immediate" } }] }) };

test("executor emit persists a declared artifact and durably addresses its execution child", async () => {
  const messages: Array<{ workflow_id: string; message: ArtifactWorkflowMessage; idempotency_key: string }> = [];
  const artifacts: ArtifactRevisionRepository = {
    emit_revision: async (_id, emission, created_at) => ({ id: "artifact-1" as ArtifactId, chain_id: "artifact-1" as ArtifactId, ...emission, version: 1, parent_artifact_id: null, created_at }),
    find_by_id: async () => null, find_tip: async () => null, list_chain: async () => [],
  };
  const app = createArtifactCallbackApp({ contexts, artifacts, send_to_workflow: async (workflow_id, message, idempotency_key) => { messages.push({ workflow_id, message, idempotency_key }); } });
  const response = await app.request("/executors/delegated_session/stage-1/units/unit-1/emit/result", { method: "PUT", headers: { "content-type": "application/json", "idempotency-key": "emit-1" }, body: JSON.stringify({ done: true }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ artifact_id: "artifact-1", version: 1, release: "released" });
  expect(messages).toEqual([{ workflow_id: "execution-workflow-1", idempotency_key: "artifact:artifact-1:released", message: { kind: "artifact_emitted", release: expect.objectContaining({ kind: "released" }) } }]);
});

test("executor emit rejects undeclared outputs without persisting", async () => {
  let persistenceCalls = 0;
  const artifacts: ArtifactRevisionRepository = { emit_revision: async () => { persistenceCalls += 1; throw new Error("unexpected"); }, find_by_id: async () => null, find_tip: async () => null, list_chain: async () => [] };
  const app = createArtifactCallbackApp({ contexts, artifacts, send_to_workflow: async () => {} });
  const response = await app.request("/executors/delegated_session/stage-1/units/unit-1/emit/wrong", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
  expect(response.status).toBe(400);
  expect(persistenceCalls).toBe(0);
});
