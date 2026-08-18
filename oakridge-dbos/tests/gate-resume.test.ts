import { expect, test } from "bun:test";

import type { ArtifactRevision } from "../src/domain/artifacts";
import type { GateDecisionAudit, GateDecisionAuditId } from "../src/domain/gates";
import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
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
    get_gate_state: async () => ({ status: "pending", stage_instance_id: stageId, execution_id: executionId, unit_id: unitId, artifact_revision_id: artifactId, gate_step: "artifact_approval", actions: ["approve", "request_revision"] }),
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
  const app = createGateResumeApp({ ...subject.dependencies, get_gate_state: async () => ({ status: "closed", action: "approve", stage_instance_id: stageId, execution_id: executionId, unit_id: unitId, artifact_revision_id: artifactId, gate_step: "artifact_approval", actions: ["approve", "request_revision"] }) });
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
    get_handoff_state: async () => ({ status: "awaiting_downstream", artifact_id: sourceId, downstream_role: "assessment" }),
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
    get_gate_state: async () => ({ status: "pending", stage_instance_id: stageId, execution_id: collectionExecutionId,
      unit_id: executionUnit, artifact_revision_id: brief.id, gate_step: "artifact_approval", actions: ["approve", "request_revision"] }),
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
    get_handoff_state: async () => ({ status: "awaiting_downstream", artifact_id: sourceId, downstream_role: "assessment" }),
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
    get_handoff_state: async (workflow_id) => workflow_id === "build-workflow:handoff:build-artifact-v2" ? { status: "awaiting_downstream", artifact_id: currentId, downstream_role: "assessment" } : null,
    send_handoff_command: async (workflow_id) => { handoffMessages.push(workflow_id); },
  };
  const response = await decide(createGateResumeApp(dependencies));
  expect(response.status).toBe(202);
  expect(handoffMessages).toEqual(["build-workflow:handoff:build-artifact-v2"]);
});
