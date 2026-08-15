import { expect, test } from "bun:test";

import { createArtifactCallbackApp } from "../src/http/artifact-callback";
import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import type { ArtifactRevisionRepository, ExecutionArtifactContextRepository } from "../src/storage/repositories";

const stageId = "stage-1" as StageInstanceId;
const unitId = "unit-1" as UnitId;
const contexts: ExecutionArtifactContextRepository = { find_for_emit: async () => ({ run_id: "run-1" as WorkflowRunId, stage_key: "build", operator_role: null, stage_instance_id: stageId, execution_id: "execution-1" as ExecutionId, unit_id: unitId, executor_type: "delegated_session", execution_workflow_id: "execution-workflow-1", inputs: [], outputs: [{ name: "result", artifact_type: "dev.result", release: { kind: "immediate" } }] }) };
const revision = (id: string, version = 1) => ({ id: id as ArtifactId, chain_id: "artifact-1" as ArtifactId, run_id: "run-1" as WorkflowRunId, stage_instance_id: stageId, execution_id: "execution-1" as ExecutionId, unit_id: unitId, output_name: "result", artifact_type: "dev.result", label: unitId, body: { done: true }, idempotency_key: "emit-1", payload_hash: "hash", version, parent_artifact_id: version === 1 ? null : "artifact-1" as ArtifactId, lifecycle: { kind: "current" as const }, created_at: "2026-08-14T00:00:00Z" });
const unusedMethods = { withdraw: async () => ({ kind: "not_found" as const, artifact_id: "missing" as ArtifactId }), mark_released: async () => ({ kind: "not_current" as const, artifact_id: "missing" as ArtifactId }), find_current: async () => null, list_pending_notifications: async () => [], mark_notification_delivered: async () => {} };

test("executor emit persists a declared artifact and durably addresses its execution child", async () => {
  let dispatches = 0;
  const artifact = revision("artifact-1");
  const artifacts: ArtifactRevisionRepository = {
    emit_revision: async () => ({ ok: true, value: { kind: "emitted", artifact, superseded_artifact_id: null } }),
    ...unusedMethods, find_by_id: async () => null, find_tip: async () => null, list_chain: async () => [],
  };
  const app = createArtifactCallbackApp({ contexts, artifacts, dispatch_notifications: async () => ++dispatches });
  const response = await app.request("/executors/delegated_session/stage-1/units/unit-1/emit/result", { method: "PUT", headers: { "content-type": "application/json", "idempotency-key": "emit-1" }, body: JSON.stringify({ done: true }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ artifact_id: "artifact-1", chain_id: "artifact-1", version: 1, state: "current", release: "released", replaced_artifact_id: null });
  expect(dispatches).toBe(1);
});

test("executor emit rejects undeclared outputs without persisting", async () => {
  let persistenceCalls = 0;
  const artifacts: ArtifactRevisionRepository = { emit_revision: async () => { persistenceCalls += 1; throw new Error("unexpected"); }, ...unusedMethods, find_by_id: async () => null, find_tip: async () => null, list_chain: async () => [] };
  const app = createArtifactCallbackApp({ contexts, artifacts, dispatch_notifications: async () => 0 });
  const response = await app.request("/executors/delegated_session/stage-1/units/unit-1/emit/wrong", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
  expect(response.status).toBe(400);
  expect(persistenceCalls).toBe(0);
});

test("legacy POST uses the same emission contract as PUT", async () => {
  const artifact = revision("artifact-1");
  const artifacts: ArtifactRevisionRepository = { emit_revision: async () => ({ ok: true, value: { kind: "emitted", artifact, superseded_artifact_id: null } }), ...unusedMethods, find_by_id: async () => null, find_tip: async () => null, list_chain: async () => [] };
  const app = createArtifactCallbackApp({ contexts, artifacts, dispatch_notifications: async () => 0 });
  const response = await app.request("/executors/delegated_session/stage-1/units/unit-1/emit/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(expect.objectContaining({ artifact_id: "artifact-1", version: 1 }));
});

test("a changed emission invalidates the superseded revision before announcing its replacement", async () => {
  const old = { ...revision("artifact-1"), lifecycle: { kind: "superseded" as const, superseded_by_artifact_id: "artifact-2" as ArtifactId } };
  const replacement = { ...revision("artifact-2", 2), chain_id: old.chain_id, parent_artifact_id: old.id };
  let dispatches = 0;
  const artifacts: ArtifactRevisionRepository = { emit_revision: async () => ({ ok: true, value: { kind: "emitted", artifact: replacement, superseded_artifact_id: old.id } }), ...unusedMethods, find_by_id: async () => old, find_tip: async () => replacement, find_current: async () => replacement, list_chain: async () => [old, replacement] };
  const app = createArtifactCallbackApp({ contexts, artifacts, dispatch_notifications: async () => ++dispatches });
  const response = await app.request("/executors/delegated_session/stage-1/units/unit-1/emit/result", { method: "PUT", headers: { "content-type": "application/json", "idempotency-key": "emit-2" }, body: JSON.stringify({ done: "better" }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(expect.objectContaining({ artifact_id: "artifact-2", replaced_artifact_id: "artifact-1" }));
  expect(dispatches).toBe(1);
});
