import { expect, test } from "bun:test";

import type { ArtifactRevision } from "../src/domain/artifacts";
import type { GateDecisionAudit, GateDecisionAuditId } from "../src/domain/gates";
import type { ArtifactId, ExecutionId, RunRecordVersion, StageInstanceId, UnitId, WaitId, WorkflowRunId } from "../src/domain/primitives";
import type { CloseRunOutputWait, CloseRunOutputWaitResult } from "../src/domain/run-record";
import { createGateResumeApp, type GateResumeDependencies } from "../src/http/gate-resume";

const stageId = "stage-1" as StageInstanceId;
const unitId = "unit-1" as UnitId;
const executionId = "execution-1" as ExecutionId;
const artifactId = "artifact-1" as ArtifactId;
const artifact: ArtifactRevision = {
  id: artifactId, chain_id: artifactId, run_id: "run-1" as WorkflowRunId, stage_instance_id: stageId,
  execution_id: executionId, unit_id: unitId, output_name: "result", artifact_type: "dev.result",
  label: null, body: { done: true }, version: 1, parent_artifact_id: null, lifecycle: { kind: "current" }, created_at: "2026-08-14T12:00:00.000Z",
};
const body = { idempotency_key: "decision-1", artifact_revision_id: artifactId, gate_step: "artifact_approval", action: "approve", operator_comment: "looks good" };

const fixture = (options: { readonly open_items?: number; readonly tip?: ArtifactRevision | null; readonly existing?: GateDecisionAudit | null } = {}) => {
  const sent: Array<{ workflow_id: string; idempotency_key: string }> = [];
  let inserted: GateDecisionAudit | null = null;
  let applied: GateDecisionAuditId | null = null;
  const dependencies: GateResumeDependencies = {
    contexts: { find_for_emit: async () => ({ run_id: artifact.run_id, stage_key: "review", operator_role: "assessment", stage_instance_id: stageId, execution_id: executionId, unit_id: unitId, executor_type: "delegated_session", execution_workflow_id: "execution-workflow-1", inputs: [], outputs: [{ name: "result", artifact_type: "dev.result", release: { kind: "gate", steps: [{ type: "artifact_approval", actions: [{ name: "approve", disposition: "release" as const }, { name: "request_revision", disposition: "revise" as const }] }], requires_zero_open_review_items: true, revision_target: "self_stage" } }] }) },
    artifacts: { emit_revision: async () => ({ ok: true, value: { kind: "unchanged", artifact, superseded_artifact_id: null } }), withdraw: async () => ({ kind: "not_found", artifact_id: artifact.id }), mark_released: async () => ({ kind: "released", artifact }), find_by_id: async () => artifact, find_tip: async () => options.tip === undefined ? artifact : options.tip, find_current: async () => options.tip === undefined ? artifact : options.tip, list_chain: async () => [artifact] },
    collaboration: {
      insert_thread_with_message: async (thread, message) => ({ thread_id: thread.id, message_id: message.id }),
      insert_thread: async (value) => value.id, insert_message: async (value) => value.id, insert_review_item: async (value) => value.id,
      find_thread: async () => null, list_threads: async () => [], update_thread_status: async () => {},
      find_review_item: async () => null, list_review_items: async () => [], update_review_item: async () => {},
      count_open_review_items: async () => options.open_items ?? 0,
    },
    audits: {
      find_by_idempotency_key: async () => options.existing ?? null,
      find_for_revision: async () => null,
      insert_idempotent: async (audit) => { inserted = audit; return audit.id; },
      mark_applied: async (id) => { applied = id; },
    },
    get_gate_state: async () => ({ status: "pending", artifact_revision_id: artifactId, gate_step: "artifact_approval", command_workflow_id: "execution-workflow-1:gate:artifact-1:wait:artifact_approval" }),
    get_handoff_state: async () => null,
    send_gate_command: async (workflow_id, _command, idempotency_key) => { sent.push({ workflow_id, idempotency_key }); },
    send_handoff_command: async () => {},
    now: () => "2026-08-14T12:30:00.000Z", new_audit_id: () => "audit-1" as GateDecisionAuditId,
  };
  return { app: createGateResumeApp(dependencies), dependencies, sent, inserted: () => inserted, applied: () => applied };
};

const decide = (app: ReturnType<typeof createGateResumeApp>, value: unknown = body) => app.request("/gates/stage-1:unit-1/resume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

test("gate resume audits and sends an idempotent command to the exact DBOS gate workflow", async () => {
  const subject = fixture();
  const response = await decide(subject.app);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ gate_id: "stage-1:unit-1", resumed: true });
  expect(subject.inserted()).toEqual(expect.objectContaining({ artifact_revision_id: artifactId, action: "approve", applied_at: null }));
  expect(subject.sent).toEqual([{ workflow_id: "execution-workflow-1:gate:artifact-1:wait:artifact_approval", idempotency_key: "decision-1" }]);
  expect(subject.applied()).toBe("audit-1" as GateDecisionAuditId);
});

test("gate resume rejects a stale artifact revision", async () => {
  const stale = { ...artifact, lifecycle: { kind: "superseded" as const, superseded_by_artifact_id: "artifact-2" as ArtifactId } };
  const subject = fixture(); subject.dependencies.artifacts.find_by_id = async () => stale;
  const response = await decide(createGateResumeApp(subject.dependencies));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "reviewed artifact revision is not current", code: "superseded" });
});

test("gate resume rejects an artifact withdrawn by durable cancellation", async () => {
  const withdrawn = { ...artifact, lifecycle: { kind: "withdrawn" as const, actor: "workflow_cancellation", reason: "cancelled", withdrawn_at: "2026-08-14T12:01:00Z" } };
  const subject = fixture(); subject.dependencies.artifacts.find_by_id = async () => withdrawn;
  const response = await decide(createGateResumeApp(subject.dependencies));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "reviewed artifact revision is not current", code: "withdrawn" });
});

test("gate resume rejects an action outside the configured step", async () => {
  const response = await decide(fixture().app, { ...body, action: "reject" });
  expect(response.status).toBe(400);
});

test("gate resume enforces the zero-open-review-items policy", async () => {
  const response = await decide(fixture({ open_items: 1 }).app);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "artifact revision has open review items" });
});

test("an applied identical idempotency key returns success without sending again", async () => {
  const existing: GateDecisionAudit = {
    id: "audit-existing" as GateDecisionAuditId, run_id: artifact.run_id, stage_instance_id: stageId, execution_id: executionId,
    unit_id: unitId, artifact_chain_id: artifactId, artifact_revision_id: artifactId, gate_step: "artifact_approval", action: "approve",
    operator_comment: "looks good", feedback: null, idempotency_key: "decision-1", created_at: artifact.created_at, applied_at: artifact.created_at,
  };
  const subject = fixture({ existing });
  const response = await decide(subject.app);
  expect(response.status).toBe(202);
  expect(subject.sent).toEqual([]);
});

test("a pending audit reconciles the crash after DBOS consumed the command", async () => {
  const existing: GateDecisionAudit = {
    id: "audit-pending" as GateDecisionAuditId, run_id: artifact.run_id, stage_instance_id: stageId, execution_id: executionId,
    unit_id: unitId, artifact_chain_id: artifactId, artifact_revision_id: artifactId, gate_step: "artifact_approval", action: "approve",
    operator_comment: "looks good", feedback: null, idempotency_key: "decision-1", created_at: artifact.created_at, applied_at: null,
  };
  const subject = fixture({ existing });
  const app = createGateResumeApp({ ...subject.dependencies, get_gate_state: async () => ({ status: "closed", action: "approve", artifact_revision_id: artifactId, gate_step: "artifact_approval", command_workflow_id: "execution-workflow-1:gate:artifact-1:wait:artifact_approval" }) });
  const response = await decide(app);
  expect(response.status).toBe(202);
  expect(subject.sent).toHaveLength(0);
  expect(subject.applied()).toBe(existing.id);
});

test("an idempotency key reused for another decision conflicts", async () => {
  const existing: GateDecisionAudit = {
    id: "audit-existing" as GateDecisionAuditId, run_id: artifact.run_id, stage_instance_id: stageId, execution_id: executionId,
    unit_id: unitId, artifact_chain_id: artifactId, artifact_revision_id: artifactId, gate_step: "artifact_approval", action: "request_revision",
    operator_comment: "change it", feedback: null, idempotency_key: "decision-1", created_at: artifact.created_at, applied_at: null,
  };
  const response = await decide(fixture({ existing }).app);
  expect(response.status).toBe(409);
});

test("an assessment decision is also correlated to its exact upstream handoff artifact", async () => {
  const subject = fixture();
  const sourceId = "build-artifact-1" as ArtifactId;
  const source: ArtifactRevision = { ...artifact, id: sourceId, chain_id: sourceId, stage_instance_id: "build-stage" as StageInstanceId, execution_id: "build-execution" as ExecutionId, output_name: "build_result", artifact_type: "dev.build_result" };
  const handoffMessages: Array<{ workflow_id: string; command: unknown }> = [];
  subject.dependencies.contexts.find_for_emit = async (requestedStage) => requestedStage === stageId ? {
    run_id: artifact.run_id, stage_key: "assessment", operator_role: "assessment", stage_instance_id: stageId, execution_id: executionId,
    unit_id: unitId, executor_type: "delegated_session", execution_workflow_id: "assessment-workflow", inputs: [{ artifact_id: sourceId, artifact_type: "dev.build_result", output_name: "build_result", unit_id: unitId, body: source.body }],
    outputs: [{ name: "result", artifact_type: "dev.result", release: { kind: "gate", steps: [{ type: "artifact_approval", actions: [{ name: "approve", disposition: "release" as const }, { name: "request_revision", disposition: "revise" as const }] }], requires_zero_open_review_items: false, revision_target: "upstream_handoff" } }],
  } : {
    run_id: artifact.run_id, stage_key: "build", operator_role: null, stage_instance_id: source.stage_instance_id, execution_id: source.execution_id,
    unit_id: unitId, executor_type: "delegated_session", execution_workflow_id: "build-workflow", inputs: [],
    outputs: [{ name: "build_result", artifact_type: "dev.build_result", release: { kind: "handoff", downstream_role: "assessment", external_wait_kind: "github_review" } }],
  };
  subject.dependencies.artifacts.find_by_id = async (id) => id === sourceId ? source : artifact;
  const dependencies: GateResumeDependencies = {
    ...subject.dependencies,
    artifacts: { ...subject.dependencies.artifacts, find_current: async (coordinate) => coordinate.output_name === "build_result" ? source : artifact },
    get_handoff_state: async () => ({ status: "awaiting_downstream", artifact_id: sourceId, downstream_role: "assessment", command_workflow_id: "build-workflow:handoff:build-artifact-1" }),
    send_handoff_command: async (workflow_id, command) => { handoffMessages.push({ workflow_id, command }); },
  };
  const app = createGateResumeApp(dependencies);
  const response = await decide(app);
  expect(response.status).toBe(202);
  expect(handoffMessages).toEqual([{ workflow_id: "build-workflow:handoff:build-artifact-1", command: { kind: "downstream_decision", action: "approve", decision_artifact_id: artifactId, feedback: "looks good" } }]);
});

/**
 * A stage may fan its artifacts out inside a single execution
 * (`materialization.kind = "artifact_collection"`) — dev-flow's brief_writer
 * emits one brief per cohort from one session. The execution stays unit "0"
 * while each artifact carries its collection key as its `unit_id`, so the two
 * are different key spaces. Comparing them refused every such gate with
 * "artifact revision does not belong to this gate unit", which made every
 * build brief unapprovable.
 */
const collectionFixture = () => {
  const executionUnit = "0" as UnitId;
  const collectionExecutionId = `${stageId}:${executionUnit}` as ExecutionId;
  const brief: ArtifactRevision = {
    ...artifact, id: "brief-1" as ArtifactId, chain_id: "brief-1" as ArtifactId,
    execution_id: collectionExecutionId,
    // The cohort id, not the execution's unit.
    unit_id: "pipefitter-tiers-spec" as UnitId,
    output_name: "result",
  };
  const base = fixture();
  const currentCoordinates: Array<{ unit_id: string }> = [];
  const dependencies: GateResumeDependencies = {
    ...base.dependencies,
    contexts: { find_for_emit: async () => ({
      run_id: brief.run_id, stage_key: "brief_writer", operator_role: "brief", stage_instance_id: stageId,
      execution_id: collectionExecutionId, unit_id: executionUnit, executor_type: "delegated_session",
      execution_workflow_id: "brief-workflow-1", inputs: [],
      outputs: [{ name: "result", artifact_type: "dev.result", release: { kind: "gate", steps: [{ type: "artifact_approval", actions: [{ name: "approve", disposition: "release" as const }, { name: "request_revision", disposition: "revise" as const }] }], requires_zero_open_review_items: false, revision_target: "self_stage" } }],
    }) },
    artifacts: { ...base.dependencies.artifacts, find_by_id: async () => brief,
      find_current: async (coordinate) => { currentCoordinates.push({ unit_id: coordinate.unit_id }); return brief; } },
    get_gate_state: async () => ({ status: "pending", artifact_revision_id: brief.id, gate_step: "artifact_approval", command_workflow_id: "brief-workflow-1" }),
  };
  return { app: createGateResumeApp(dependencies), brief, executionUnit, currentCoordinates };
};

const decideCollection = (app: ReturnType<typeof createGateResumeApp>, briefId: string) =>
  app.request("/gates/stage-1:0/resume", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, artifact_revision_id: briefId }) });

test("a gate approves an artifact whose unit is a collection key rather than the execution's unit", async () => {
  const subject = collectionFixture();
  const response = await decideCollection(subject.app, subject.brief.id);
  expect(response.status).toBe(202);
});

/** Staleness is a question about the artifact's own coordinate, not the gate's. */
test("the staleness check is keyed by the artifact's unit, not the gate's", async () => {
  const subject = collectionFixture();
  await decideCollection(subject.app, subject.brief.id);
  expect(subject.currentCoordinates).toEqual([{ unit_id: "pipefitter-tiers-spec" }]);
});

/** The execution binding still holds: another execution's artifact is refused. */
test("an artifact from a different execution is still refused", async () => {
  const base = fixture();
  const foreign: ArtifactRevision = {
    ...artifact, id: "brief-9" as ArtifactId, chain_id: "brief-9" as ArtifactId,
    execution_id: `${stageId}:9` as ExecutionId, unit_id: "pipefitter-tiers-spec" as UnitId,
  };
  const app = createGateResumeApp({
    ...base.dependencies,
    contexts: { find_for_emit: async () => ({
      run_id: foreign.run_id, stage_key: "brief_writer", operator_role: "brief", stage_instance_id: stageId,
      execution_id: `${stageId}:0` as ExecutionId, unit_id: "0" as UnitId, executor_type: "delegated_session",
      execution_workflow_id: "brief-workflow-1", inputs: [],
      outputs: [{ name: "result", artifact_type: "dev.result", release: { kind: "gate", steps: [{ type: "artifact_approval", actions: [{ name: "approve", disposition: "release" as const }] }], requires_zero_open_review_items: false, revision_target: "self_stage" } }],
    }) },
    artifacts: { ...base.dependencies.artifacts, find_by_id: async () => foreign, find_current: async () => foreign },
  });
  const response = await decideCollection(app, foreign.id);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "artifact revision does not belong to this gate unit" });
});

/**
 * The upstream handoff carries the rejection as well as the approval. Both
 * decisions are the downstream role's to make; only the action differs.
 */
test("gate resume routes a revision request to the upstream handoff", async () => {
  const subject = fixture();
  const sourceId = "build-artifact-2" as ArtifactId;
  const source: ArtifactRevision = { ...artifact, id: sourceId, chain_id: sourceId, stage_instance_id: "build-stage" as StageInstanceId, execution_id: "build-execution" as ExecutionId, output_name: "build_result", artifact_type: "dev.build_result" };
  subject.dependencies.contexts.find_for_emit = async (requestedStage) => requestedStage === stageId
    ? { run_id: artifact.run_id, stage_key: "assessment", operator_role: "assessment", stage_instance_id: stageId, execution_id: executionId, unit_id: unitId, executor_type: "delegated_session", execution_workflow_id: "assessment-workflow", inputs: [{ artifact_id: sourceId, artifact_type: "dev.build_result", output_name: "build_result", unit_id: unitId, body: source.body }], outputs: [{ name: "result", artifact_type: "dev.result", release: { kind: "gate", steps: [{ type: "artifact_approval", actions: [{ name: "approve", disposition: "release" as const }, { name: "request_revision", disposition: "revise" as const }] }], requires_zero_open_review_items: false, revision_target: "upstream_handoff" } }] }
    : { run_id: artifact.run_id, stage_key: "build", operator_role: null, stage_instance_id: source.stage_instance_id, execution_id: source.execution_id, unit_id: unitId, executor_type: "delegated_session", execution_workflow_id: "build-workflow", inputs: [], outputs: [{ name: "build_result", artifact_type: "dev.build_result", release: { kind: "handoff", downstream_role: "assessment", external_wait_kind: "github_review" } }] };
  const handoffMessages: Array<{ workflow_id: string; command: unknown }> = [];
  const dependencies: GateResumeDependencies = {
    ...subject.dependencies,
    artifacts: { ...subject.dependencies.artifacts, find_by_id: async (id) => id === sourceId ? source : artifact, find_current: async (coordinate) => coordinate.output_name === "build_result" ? source : artifact },
    get_handoff_state: async () => ({ status: "awaiting_downstream", artifact_id: sourceId, downstream_role: "assessment", command_workflow_id: "build-workflow:handoff:build-artifact-2" }),
    send_handoff_command: async (workflow_id, command) => { handoffMessages.push({ workflow_id, command }); },
  };
  const response = await decide(createGateResumeApp(dependencies), { ...body, action: "request_revision" });
  expect(response.status).toBe(202);
  expect(handoffMessages).toEqual([{ workflow_id: "build-workflow:handoff:build-artifact-2", command: { kind: "downstream_decision", action: "request_revision", decision_artifact_id: artifactId, feedback: "looks good" } }]);
});

/**
 * The second round of a revision loop.
 *
 * The assessor's recorded input still names the revision it was launched with,
 * but the handoff waiting on a decision belongs to the revision the build
 * emitted after the rejection. Provenance follows the chain, not the recorded
 * id — without this the reassessment is refused as unrelated to any pending
 * handoff, and the run stops with a revised build nobody can accept.
 */
test("gate resume resolves the upstream handoff to the current revision of the input", async () => {
  const subject = fixture();
  const recordedId = "build-artifact-v1" as ArtifactId;
  const currentId = "build-artifact-v2" as ArtifactId;
  const recorded: ArtifactRevision = { ...artifact, id: recordedId, chain_id: recordedId, stage_instance_id: "build-stage" as StageInstanceId, execution_id: "build-execution" as ExecutionId, output_name: "build_result", artifact_type: "dev.build_result", lifecycle: { kind: "superseded", superseded_by_artifact_id: currentId } };
  const current: ArtifactRevision = { ...recorded, id: currentId, version: 2, lifecycle: { kind: "current" } };
  subject.dependencies.contexts.find_for_emit = async (requestedStage) => requestedStage === stageId
    ? { run_id: artifact.run_id, stage_key: "assessment", operator_role: "assessment", stage_instance_id: stageId, execution_id: executionId, unit_id: unitId, executor_type: "delegated_session", execution_workflow_id: "assessment-workflow", inputs: [{ artifact_id: recordedId, artifact_type: "dev.build_result", output_name: "build_result", unit_id: unitId, body: recorded.body }], outputs: [{ name: "result", artifact_type: "dev.result", release: { kind: "gate", steps: [{ type: "artifact_approval", actions: [{ name: "approve", disposition: "release" as const }, { name: "request_revision", disposition: "revise" as const }] }], requires_zero_open_review_items: false, revision_target: "upstream_handoff" } }] }
    : { run_id: artifact.run_id, stage_key: "build", operator_role: null, stage_instance_id: recorded.stage_instance_id, execution_id: recorded.execution_id, unit_id: unitId, executor_type: "delegated_session", execution_workflow_id: "build-workflow", inputs: [], outputs: [{ name: "build_result", artifact_type: "dev.build_result", release: { kind: "handoff", downstream_role: "assessment", external_wait_kind: "github_review" } }] };
  const handoffMessages: string[] = [];
  const dependencies: GateResumeDependencies = {
    ...subject.dependencies,
    artifacts: { ...subject.dependencies.artifacts, find_by_id: async (id) => id === recordedId ? recorded : artifact, find_current: async (coordinate) => coordinate.output_name === "build_result" ? current : artifact },
    // Round two of a revision loop resolves the handoff by the CURRENT
    // revision — the fake matches on that id, exactly what this test proves.
    get_handoff_state: async (artifact_id) => artifact_id === currentId ? { status: "awaiting_downstream", artifact_id: currentId, downstream_role: "assessment", command_workflow_id: "build-workflow:handoff:build-artifact-v2" } : null,
    send_handoff_command: async (workflow_id) => { handoffMessages.push(workflow_id); },
  };
  const response = await decide(createGateResumeApp(dependencies));
  expect(response.status).toBe(202);
  expect(handoffMessages).toEqual(["build-workflow:handoff:build-artifact-v2"]);
});

/**
 * The v2 gate command. Unlike the legacy route above, there is no DBOS gate
 * workflow — the whole fact is `RunRecordRepository.close_output_wait`, called
 * directly. These tests never touch `send_gate_command`.
 */
const waitId = "99999999-9999-4999-8999-999999999999" as WaitId;
const v2RunId = "88888888-8888-4888-8888-888888888888" as WorkflowRunId;

const v2Fixture = (close_output_wait: (request: CloseRunOutputWait) => Promise<CloseRunOutputWaitResult>) =>
  createGateResumeApp({ ...fixture().dependencies, records: { close_output_wait } });

const resumeV2 = (app: ReturnType<typeof createGateResumeApp>, body: unknown, id = waitId) =>
  app.request(`/v2/waits/${id}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("v2 gate resume releases the wait and reports the released artifact", async () => {
  let received: CloseRunOutputWait | null = null;
  const app = v2Fixture(async (request) => {
    received = request;
    return { kind: "released", artifact_id: "artifact-9" as ArtifactId, run_id: v2RunId, record_version: 6 as RunRecordVersion };
  });
  const response = await resumeV2(app, { disposition: "release", actor: "operator:sam", detail: "looks good" });
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ wait_id: waitId, state: "released", artifact_id: "artifact-9", record_version: 6 });
  expect(received).toEqual(expect.objectContaining({ wait_id: waitId, disposition: "release", actor: "operator:sam", detail: "looks good" }));
});

test("the public gate route dispatches a v2 wait id directly to its run-owned policy command", async () => {
  const actions: string[] = [];
  const app = createGateResumeApp({ ...fixture().dependencies, records: { close_output_wait: async () => ({ kind: "wait_not_found", detail: "unused" }),
    decide_gate_wait: async (request) => { actions.push(request.action); return { kind: "released", artifact_id: artifact.id, run_id: v2RunId, record_version: 8 as RunRecordVersion }; } } });
  const response = await app.request(`/gates/${waitId}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(response.status).toBe(202);
  expect(actions).toEqual(["approve"]);
});

test("v2 gate resume invalidates on request", async () => {
  const app = v2Fixture(async () => ({ kind: "invalidated", run_id: v2RunId, record_version: 7 as RunRecordVersion }));
  const response = await resumeV2(app, { disposition: "invalidate", actor: "operator:sam" });
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ wait_id: waitId, state: "invalidated", record_version: 7 });
});

test("v2 gate resume absorbs a retried decision", async () => {
  const app = v2Fixture(async () => ({ kind: "already_applied", run_id: v2RunId, record_version: 6 as RunRecordVersion }));
  const response = await resumeV2(app, { disposition: "release", actor: "operator:sam" });
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ wait_id: waitId, state: "already_applied", record_version: 6 });
});

test("v2 gate resume reports an unknown wait as 404", async () => {
  const app = v2Fixture(async () => ({ kind: "wait_not_found", detail: "v2 wait was not found" }));
  const response = await resumeV2(app, { disposition: "release", actor: "operator:sam" });
  expect(response.status).toBe(404);
});

test("v2 gate resume refuses a conflicting disposition", async () => {
  const app = v2Fixture(async () => ({ kind: "wait_conflict", detail: "already closed under a different disposition" }));
  const response = await resumeV2(app, { disposition: "invalidate", actor: "operator:sam" });
  expect(response.status).toBe(409);
});

test("v2 gate resume rejects a malformed disposition without calling the domain command", async () => {
  let calls = 0;
  const app = v2Fixture(async () => { calls += 1; return { kind: "released", artifact_id: "artifact-9" as ArtifactId, run_id: v2RunId, record_version: 1 as RunRecordVersion }; });
  const response = await resumeV2(app, { disposition: "approve", actor: "operator:sam" });
  expect(response.status).toBe(400);
  expect(calls).toBe(0);
});

test("v2 gate resume is inert without a wired run record", async () => {
  const app = createGateResumeApp(fixture().dependencies);
  const response = await resumeV2(app, { disposition: "release", actor: "operator:sam" });
  expect(response.status).toBe(501);
});
