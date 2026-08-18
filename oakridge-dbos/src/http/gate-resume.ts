import { randomUUID } from "node:crypto";

import { Hono } from "hono";

import type { CompiledOutputContract } from "../domain/compiled-workflow";
import type { GateDecisionAudit, GateDecisionAuditId } from "../domain/gates";
import type { ArtifactId, StageInstanceId, UnitId } from "../domain/primitives";
import type {
  ArtifactRevisionRepository,
  CollaborationRepository,
  ExecutionArtifactContext,
  ExecutionArtifactContextRepository,
  GateDecisionAuditRepository,
} from "../storage/repositories";
import { gateWaitWorkflowId, handoffWorkflowId } from "../domain/workflow-ids";
import type { GateCommand, GateWaitInput } from "../workflows/gate";
import type { HandoffCommand } from "../workflows/handoff";

export interface GateWorkflowState extends GateWaitInput {
  readonly status: "pending" | "closed" | "superseded" | "withdrawn";
  readonly action?: string;
}

export interface HandoffWorkflowState {
  readonly status: "awaiting_downstream" | "awaiting_external" | "revision_requested" | "released" | "superseded" | "withdrawn";
  readonly artifact_id: ArtifactId;
  readonly downstream_role?: string;
  readonly decision_artifact_id?: string;
}

export interface GateResumeDependencies {
  readonly contexts: ExecutionArtifactContextRepository;
  readonly artifacts: ArtifactRevisionRepository;
  readonly collaboration: CollaborationRepository;
  readonly audits: GateDecisionAuditRepository;
  readonly get_gate_state: (workflow_id: string) => Promise<GateWorkflowState | null>;
  readonly send_gate_command: (workflow_id: string, command: GateCommand, idempotency_key: string) => Promise<void>;
  readonly get_handoff_state: (workflow_id: string) => Promise<HandoffWorkflowState | null>;
  readonly send_handoff_command: (workflow_id: string, command: HandoffCommand, idempotency_key: string) => Promise<void>;
  readonly now?: () => string;
  readonly new_audit_id?: () => GateDecisionAuditId;
}

interface GateResumeRequest {
  readonly idempotency_key: string;
  readonly artifact_revision_id: string;
  readonly gate_step: string;
  readonly action: string;
  readonly operator_comment: string;
  readonly feedback?: string | null;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const parseRequest = (value: unknown): GateResumeRequest | null => {
  if (!isObject(value)) return null;
  if (typeof value.idempotency_key !== "string" || value.idempotency_key.trim() === "") return null;
  if (typeof value.artifact_revision_id !== "string" || value.artifact_revision_id.trim() === "") return null;
  if (typeof value.gate_step !== "string" || value.gate_step.trim() === "") return null;
  if (typeof value.action !== "string" || value.action.trim() === "") return null;
  if (typeof value.operator_comment !== "string" || value.operator_comment.trim() === "") return null;
  if (value.feedback !== undefined && value.feedback !== null && typeof value.feedback !== "string") return null;
  return {
    idempotency_key: value.idempotency_key.trim(), artifact_revision_id: value.artifact_revision_id.trim(),
    gate_step: value.gate_step.trim(), action: value.action.trim(), operator_comment: value.operator_comment.trim(),
    feedback: typeof value.feedback === "string" ? value.feedback.trim() || null : value.feedback,
  };
};

const findGateOutput = (context: ExecutionArtifactContext, output_name: string): Extract<CompiledOutputContract["release"], { kind: "gate" }> | null => {
  const release = context.outputs.find((output) => output.name === output_name)?.release;
  return release?.kind === "gate" ? release : null;
};

const sameDecision = (audit: GateDecisionAudit, request: GateResumeRequest, stage_id: StageInstanceId, unit_id: UnitId): boolean =>
  audit.stage_instance_id === stage_id && audit.unit_id === unit_id &&
  audit.artifact_revision_id === request.artifact_revision_id && audit.gate_step === request.gate_step &&
  audit.action === request.action && audit.operator_comment === request.operator_comment &&
  audit.feedback === (request.feedback ?? null);

interface ResolvedHandoffTarget { readonly workflow_id: string; readonly source_artifact_id: ArtifactId; readonly should_send: boolean }

const resolveHandoffTarget = async (dependencies: GateResumeDependencies, context: ExecutionArtifactContext, consumed_decision_artifact_id: ArtifactId | null): Promise<ResolvedHandoffTarget | null> => {
  for (const input of context.inputs) {
    const source = await dependencies.artifacts.find_by_id(input.artifact_id);
    if (!source) continue;
    const producer = await dependencies.contexts.find_for_emit(source.stage_instance_id, source.unit_id);
    if (!producer) continue;
    const release = producer.outputs.find((output) => output.name === source.output_name)?.release;
    if (release?.kind !== "handoff" || release.downstream_role !== context.operator_role) continue;
    const workflow_id = handoffWorkflowId(producer.execution_workflow_id, source.id);
    const state = await dependencies.get_handoff_state(workflow_id);
    if (state?.status === "awaiting_downstream" && state.artifact_id === source.id && state.downstream_role === context.operator_role) return { workflow_id, source_artifact_id: source.id, should_send: true };
    if (consumed_decision_artifact_id && state?.artifact_id === source.id && state.decision_artifact_id === consumed_decision_artifact_id && ["awaiting_external", "revision_requested", "released"].includes(state.status)) {
      return { workflow_id, source_artifact_id: source.id, should_send: false };
    }
  }
  return null;
};

export const createGateResumeApp = (dependencies: GateResumeDependencies): Hono => {
  const app = new Hono();
  app.post("/gates/:id/resume", async (http) => {
    const compositeId = http.req.param("id");
    const separator = compositeId.indexOf(":");
    if (separator < 1 || separator === compositeId.length - 1) return http.json({ error: "invalid gate id: expected '{stage_id}:{unit_id}'" }, 400);
    const stageId = compositeId.slice(0, separator) as StageInstanceId;
    const unitId = compositeId.slice(separator + 1) as UnitId;
    let rawBody: unknown;
    try { rawBody = await http.req.json(); } catch { return http.json({ error: "request body must be JSON" }, 400); }
    const request = parseRequest(rawBody);
    if (!request) return http.json({ error: "idempotency_key, artifact_revision_id, gate_step, action, and operator_comment are required strings" }, 400);

    const existing = await dependencies.audits.find_by_idempotency_key(request.idempotency_key);
    if (existing && !sameDecision(existing, request, stageId, unitId)) return http.json({ error: `idempotency key '${request.idempotency_key}' was already used for a different gate decision` }, 409);
    if (existing?.applied_at) return http.json({ gate_id: compositeId, resumed: true }, 202);

    const context = await dependencies.contexts.find_for_emit(stageId, unitId);
    if (!context) return http.json({ error: "gate unit not found" }, 404);
    const artifactId = request.artifact_revision_id as ArtifactId;
    const artifact = await dependencies.artifacts.find_by_id(artifactId);
    // A stage that fans its artifacts out inside one execution
    // (`materialization.kind = "artifact_collection"`, e.g. one brief per
    // cohort) puts the collection key on the artifact while the execution
    // itself stays a single unit. The artifact's `unit_id` and the gate's are
    // then different key spaces, and comparing them refuses every such gate.
    // Stage plus execution already binds the artifact to this gate — an
    // execution id is `{stage_instance}:{unit}`, so it is unit-specific — and
    // that holds for both shapes.
    if (!artifact || artifact.stage_instance_id !== stageId || artifact.execution_id !== context.execution_id) {
      return http.json({ error: "artifact revision does not belong to this gate unit" }, 409);
    }
    if (artifact.lifecycle.kind !== "current") return http.json({ error: "reviewed artifact revision is not current", code: artifact.lifecycle.kind }, 409);
    const gate = findGateOutput(context, artifact.output_name);
    if (!gate) return http.json({ error: "artifact output does not have a gate release" }, 409);
    const step = gate.steps.find((candidate) => candidate.type === request.gate_step);
    if (!step) return http.json({ error: "reviewed gate step is stale" }, 409);
    if (!step.actions.some((candidate) => candidate.name === request.action)) return http.json({ error: `action '${request.action}' is not allowed for the current gate step` }, 400);
    const workflowId = gateWaitWorkflowId(context.execution_workflow_id, artifact.id, request.gate_step);
    // Staleness is a question about this artifact's own coordinate, so it is
    // keyed by the artifact's unit rather than the gate's — they diverge for an
    // artifact collection, where the gate's unit addresses the execution.
    const current = await dependencies.artifacts.find_current({ stage_instance_id: stageId, execution_id: context.execution_id, unit_id: artifact.unit_id, output_name: artifact.output_name });
    if (!current || current.id !== artifact.id) return http.json({ error: "reviewed artifact revision is stale" }, 409);
    if (gate.requires_zero_open_review_items && await dependencies.collaboration.count_open_review_items(artifact.id) > 0) {
      return http.json({ error: "artifact revision has open review items" }, 409);
    }

    const state = await dependencies.get_gate_state(workflowId);
    const wasConsumed = Boolean(existing && state?.status === "closed" && state.action === request.action && state.artifact_revision_id === artifact.id && state.gate_step === request.gate_step);
    if (!wasConsumed && (!state || state.status !== "pending" || state.artifact_revision_id !== artifact.id || state.gate_step !== request.gate_step)) {
      return http.json({ error: "reviewed artifact revision or gate step is not pending" }, 409);
    }
    const handoffTarget = gate.revision_target === "upstream_handoff" ? await resolveHandoffTarget(dependencies, context, existing ? artifact.id : null) : null;
    if (gate.revision_target === "upstream_handoff" && !handoffTarget) return http.json({ error: "artifact provenance does not match a pending upstream handoff" }, 409);
    const now = (dependencies.now ?? (() => new Date().toISOString()))();
    const audit: GateDecisionAudit = {
      id: (dependencies.new_audit_id ?? (() => randomUUID() as GateDecisionAuditId))(),
      run_id: context.run_id, stage_instance_id: stageId, execution_id: context.execution_id, unit_id: unitId,
      artifact_chain_id: artifact.chain_id, artifact_revision_id: artifact.id, gate_step: request.gate_step,
      action: request.action, operator_comment: request.operator_comment, feedback: request.feedback ?? null,
      idempotency_key: request.idempotency_key, created_at: now, applied_at: null,
    };
    const auditId = existing?.id ?? await dependencies.audits.insert_idempotent(audit);
    if (!wasConsumed) await dependencies.send_gate_command(workflowId, { kind: "decision", action: request.action, artifact_revision_id: artifact.id, gate_step: request.gate_step }, request.idempotency_key);
    if (handoffTarget?.should_send) await dependencies.send_handoff_command(handoffTarget.workflow_id, { kind: "downstream_decision", action: request.action, decision_artifact_id: artifact.id, feedback: request.feedback ?? request.operator_comment }, request.idempotency_key);
    await dependencies.audits.mark_applied(auditId, (dependencies.now ?? (() => new Date().toISOString()))());
    return http.json({ gate_id: compositeId, resumed: true }, 202);
  });
  return app;
};
