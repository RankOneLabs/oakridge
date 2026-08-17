import { expect, test } from "bun:test";

import type { ArtifactRevision, WithdrawArtifactResult } from "../src/domain/artifacts";
import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { createArtifactWithdrawApp } from "../src/http/artifact-withdraw";
import type { ArtifactRevisionRepository } from "../src/storage/repositories";

const artifactId = "11111111-1111-4111-8111-111111111111" as ArtifactId;
const artifact: ArtifactRevision = {
  id: artifactId, chain_id: artifactId, run_id: "22222222-2222-4222-8222-222222222222" as WorkflowRunId, stage_instance_id: "33333333-3333-4333-8333-333333333333" as StageInstanceId,
  execution_id: "execution-1" as ExecutionId, unit_id: "unit-1" as UnitId, output_name: "result", artifact_type: "dev.result",
  label: null, body: { done: true }, version: 1, parent_artifact_id: null, lifecycle: { kind: "current" }, created_at: "2026-08-14T12:00:00Z",
};

const fixture = (result: WithdrawArtifactResult) => {
  let dispatches = 0;
  let request: Parameters<ArtifactRevisionRepository["withdraw"]>[0] | null = null;
  const artifacts: ArtifactRevisionRepository = {
    emit_revision: async () => ({ ok: true, value: { kind: "unchanged", artifact, superseded_artifact_id: null } }),
    withdraw: async (value) => { request = value; return result; },
    mark_released: async () => ({ kind: "released", artifact }),
    find_by_id: async () => artifact, find_tip: async () => artifact, find_current: async () => artifact, list_chain: async () => [artifact],
  };
  const app = createArtifactWithdrawApp({
    artifacts,
    contexts: { find_for_emit: async () => ({ run_id: artifact.run_id, stage_key: "build", operator_role: null, stage_instance_id: artifact.stage_instance_id, execution_id: artifact.execution_id, unit_id: artifact.unit_id, executor_type: "delegated_session", execution_workflow_id: "execution-workflow-1", inputs: [], outputs: [] }) },
    dispatch_notifications: async () => ++dispatches,
    now: () => "2026-08-14T12:30:00Z",
  });
  return { app, request: () => request, dispatches: () => dispatches };
};

const withdraw = (app: ReturnType<typeof createArtifactWithdrawApp>, body: unknown = { actor: "agent", reason: "incorrect report" }) => app.request("/artifacts/11111111-1111-4111-8111-111111111111/withdraw", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("withdrawal persists audit metadata and dispatches its durable invalidation", async () => {
  const withdrawn = { ...artifact, lifecycle: { kind: "withdrawn" as const, actor: "agent", reason: "incorrect report", withdrawn_at: "2026-08-14T12:30:00Z" } };
  const subject = fixture({ kind: "withdrawn", artifact: withdrawn });
  const response = await withdraw(subject.app);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ kind: "withdrawn", artifact_id: "11111111-1111-4111-8111-111111111111", withdrawn_at: "2026-08-14T12:30:00Z" });
  expect(subject.request()).toEqual({ artifact_id: artifactId, actor: "agent", reason: "incorrect report", withdrawn_at: "2026-08-14T12:30:00Z", target_workflow_id: "execution-workflow-1" });
  expect(subject.dispatches()).toBe(1);
});

test("repeated withdrawal is idempotent", async () => {
  const withdrawn = { ...artifact, lifecycle: { kind: "withdrawn" as const, actor: "agent", reason: "incorrect report", withdrawn_at: "2026-08-14T12:30:00Z" } };
  const response = await withdraw(fixture({ kind: "already_withdrawn", artifact: withdrawn }).app);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(expect.objectContaining({ kind: "already_withdrawn", artifact_id: "11111111-1111-4111-8111-111111111111" }));
});

test("superseded and released revisions return typed conflicts without dispatch", async () => {
  const stale = fixture({ kind: "not_current", artifact_id: artifactId, current_artifact_id: "44444444-4444-4444-8444-444444444444" as ArtifactId });
  const staleResponse = await withdraw(stale.app);
  expect(staleResponse.status).toBe(409);
  expect(await staleResponse.json()).toEqual({ kind: "not_current", artifact_id: "11111111-1111-4111-8111-111111111111", current_artifact_id: "44444444-4444-4444-8444-444444444444" });
  expect(stale.dispatches()).toBe(0);

  const released = fixture({ kind: "release_conflict", artifact_id: artifactId, released_at: "2026-08-14T12:20:00Z" });
  const releasedResponse = await withdraw(released.app);
  expect(releasedResponse.status).toBe(409);
  expect(await releasedResponse.json()).toEqual({ kind: "release_conflict", artifact_id: "11111111-1111-4111-8111-111111111111", released_at: "2026-08-14T12:20:00Z" });
  expect(released.dispatches()).toBe(0);
});

test("withdrawal requires non-empty actor and reason", async () => {
  const response = await withdraw(fixture({ kind: "not_found", artifact_id: artifactId }).app, { actor: "", reason: "" });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: "invalid_withdrawal", message: "actor and reason are required strings" } });
});
