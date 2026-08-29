import { expect, test } from "bun:test";

import type { ArtifactRevision } from "../src/domain/artifacts";
import type { ArtifactId, ExecutionId, RunRecordVersion, StageInstanceId, UnitId, WaitId, WorkflowRunId } from "../src/domain/primitives";
import type { CloseRunOutputWait, CloseRunOutputWaitResult } from "../src/domain/run-record";
import { createHandoffCompleteApp, type HandoffCompleteDependencies } from "../src/http/handoff-complete";

const artifact: ArtifactRevision = {
  id: "11111111-1111-4111-8111-111111111111" as ArtifactId, chain_id: "11111111-1111-4111-8111-111111111111" as ArtifactId, run_id: "22222222-2222-4222-8222-222222222222" as WorkflowRunId,
  stage_instance_id: "33333333-3333-4333-8333-333333333333" as StageInstanceId, execution_id: "build-execution" as ExecutionId, unit_id: "unit-1" as UnitId,
  output_name: "build_result", artifact_type: "dev.build_result", label: null, body: {}, version: 1, parent_artifact_id: null, lifecycle: { kind: "current" }, created_at: "2026-08-14T12:00:00Z",
};

const fixture = (state: "awaiting_external" | "awaiting_downstream" = "awaiting_external") => {
  const sent: Array<{ workflow_id: string; command: unknown; key: string }> = [];
  const dependencies: HandoffCompleteDependencies = {
    artifacts: { emit_revision: async () => ({ ok: true, value: { kind: "unchanged", artifact, superseded_artifact_id: null } }), withdraw: async () => ({ kind: "not_found", artifact_id: artifact.id }), mark_released: async () => ({ kind: "released", artifact }), find_by_id: async () => artifact, find_tip: async () => artifact, find_current: async () => artifact, list_chain: async () => [artifact] },
    contexts: { find_for_emit: async () => ({ run_id: artifact.run_id, stage_key: "build", operator_role: null, stage_instance_id: artifact.stage_instance_id, execution_id: artifact.execution_id, unit_id: artifact.unit_id, executor_type: "delegated_session", execution_workflow_id: "build-workflow", inputs: [], outputs: [{ name: "build_result", artifact_type: "dev.build_result", release: { kind: "handoff", downstream_role: "assessment", external_wait_kind: "github_review" } }] }) },
    get_handoff_state: async () => ({ status: state, artifact_id: artifact.id, command_workflow_id: "build-workflow:handoff:11111111-1111-4111-8111-111111111111" }),
    send_handoff_command: async (workflow_id, command, key) => { sent.push({ workflow_id, command, key }); },
  };
  return { app: createHandoffCompleteApp(dependencies), sent, dependencies };
};

const complete = (app: ReturnType<typeof createHandoffCompleteApp>, external_kind = "github_review") => app.request("/handoffs/11111111-1111-4111-8111-111111111111/external-complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ external_kind, correlation_id: "pr-review-42", idempotency_key: "github-review-42" }) });

test("external completion releases the exact durable handoff wait idempotently", async () => {
  const subject = fixture();
  const response = await complete(subject.app);
  expect(response.status).toBe(202);
  expect(subject.sent).toEqual([{ workflow_id: "build-workflow:handoff:11111111-1111-4111-8111-111111111111", key: "github-review-42", command: { kind: "external_completed", external_kind: "github_review", correlation_id: "pr-review-42" } }]);
});

test("external completion rejects the wrong configured kind", async () => {
  const response = await complete(fixture().app, "deployment");
  expect(response.status).toBe(409);
});

test("external completion cannot arrive before downstream approval", async () => {
  const response = await complete(fixture("awaiting_downstream").app);
  expect(response.status).toBe(409);
});

/**
 * The v2 external-completion command. As with the v2 gate route, there is no
 * DBOS handoff workflow — `RunRecordRepository.close_output_wait` is the whole
 * fact, called directly. These tests never touch `send_handoff_command`.
 */
const waitId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as WaitId;
const v2RunId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as WorkflowRunId;

const v2Fixture = (close_output_wait: (request: CloseRunOutputWait) => Promise<CloseRunOutputWaitResult>) =>
  createHandoffCompleteApp({ ...fixture().dependencies, records: { close_output_wait } });

const completeV2 = (app: ReturnType<typeof createHandoffCompleteApp>, id = waitId) =>
  app.request(`/v2/waits/${id}/external-complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ correlation_id: "pr-review-42", actor: "poller:github" }) });

test("v2 external completion releases the wait and reports the released artifact", async () => {
  let received: CloseRunOutputWait | null = null;
  const app = v2Fixture(async (request) => {
    received = request;
    return { kind: "released", artifact_id: "artifact-9" as ArtifactId, run_id: v2RunId, record_version: 3 as RunRecordVersion };
  });
  const response = await completeV2(app);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ wait_id: waitId, state: "released", artifact_id: "artifact-9", record_version: 3 });
  expect(received).toEqual(expect.objectContaining({ wait_id: waitId, disposition: "release", actor: "poller:github", detail: "pr-review-42" }));
});

test("v2 external completion absorbs a retried confirmation", async () => {
  const app = v2Fixture(async () => ({ kind: "already_applied", run_id: v2RunId, record_version: 3 as RunRecordVersion }));
  const response = await completeV2(app);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ wait_id: waitId, state: "already_applied", record_version: 3 });
});

test("v2 external completion reports an unknown wait as 404", async () => {
  const app = v2Fixture(async () => ({ kind: "wait_not_found", detail: "v2 wait was not found" }));
  const response = await completeV2(app);
  expect(response.status).toBe(404);
});

test("v2 external completion is inert without a wired run record", async () => {
  const app = createHandoffCompleteApp(fixture().dependencies);
  const response = await completeV2(app);
  expect(response.status).toBe(501);
});
