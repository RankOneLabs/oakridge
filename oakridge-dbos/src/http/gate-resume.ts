import { randomUUID } from "node:crypto";

import { Hono } from "hono";

import type { CompiledOutputContract } from "../domain/compiled-workflow";
import type { GateDecisionAudit, GateDecisionAuditId } from "../domain/gates";
import { parseUuidId, type ArtifactId, type StageInstanceId, type UnitId, type WaitId } from "../domain/primitives";
import type { RunOutputWaitDisposition } from "../domain/run-record";
import type {
  ArtifactRevisionRepository,
  CollaborationRepository,
  ExecutionArtifactContext,
  ExecutionArtifactContextRepository,
  GateDecisionAuditRepository,
  RunRecordRepository,
} from "../storage/repositories";
import type { GateWorkflowState, HandoffWorkflowState } from "../domain/wait";
import type { GateCommand } from "../workflows/gate";
import type { HandoffCommand } from "../workflows/handoff";

export interface GateResumeDependencies {
  readonly contexts: ExecutionArtifactContextRepository;
  readonly artifacts: ArtifactRevisionRepository;
  readonly collaboration: CollaborationRepository;
  readonly audits: GateDecisionAuditRepository;
  /** The wait record, keyed by what the caller holds; the execution predicate
   *  binds the read to the live attempt, exactly as the deleted workflow-id
   *  reconstruction did. */
  readonly get_gate_state: (artifact_revision_id: ArtifactId, gate_step: string, execution_workflow_id: string) => Promise<GateWorkflowState | null>;
  readonly send_gate_command: (workflow_id: string, command: GateCommand, idempotency_key: string) => Promise<void>;
  readonly get_handoff_state: (artifact_id: ArtifactId, execution_workflow_id: string) => Promise<HandoffWorkflowState | null>;
  readonly send_handoff_command: (workflow_id: string, command: HandoffCommand, idempotency_key: string) => Promise<void>;
  readonly now?: () => string;
  readonly new_audit_id?: () => GateDecisionAuditId;
  /**
   * The v2 run record, present only where a v2 gate wait may need resolving.
   * Absent for a backend that has not cut any run over to v2 yet — the legacy
   * route above is unaffected either way.
   */
  readonly records?: Pick<RunRecordRepository, "close_output_wait"> & Partial<Pick<RunRecordRepository, "decide_gate_wait">>;
  /** Wakes the run's root workflow sooner than its bounded recheck; absent is fine — the recheck still happens. */
  readonly send_run_wake?: (run_id: string, idempotency_key: string) => Promise<void>;
}

interface V2WaitResumeRequest { readonly disposition: RunOutputWaitDisposition; readonly actor: string; readonly detail: string | null }

const parseV2WaitResumeRequest = (value: unknown): V2WaitResumeRequest | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as { readonly [key: string]: unknown };
  if (body.disposition !== "release" && body.disposition !== "invalidate") return null;
  if (typeof body.actor !== "string" || body.actor.trim() === "") return null;
  if (body.detail !== undefined && body.detail !== null && typeof body.detail !== "string") return null;
  return { disposition: body.disposition, actor: body.actor.trim(), detail: typeof body.detail === "string" ? body.detail : null };
};

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
    const recorded = await dependencies.artifacts.find_by_id(input.artifact_id);
    if (!recorded) continue;
    // The recorded input is the revision this execution was *launched* with. If
    // the upstream unit has revised it since, the handoff waiting on a decision
    // belongs to the newer revision — the old one's handoff has already
    // returned — so resolve to whatever is current at that coordinate. Without
    // this, the second round of a revision loop looks for a decision on a
    // superseded artifact and finds none.
    const source = await dependencies.artifacts.find_current({
      stage_instance_id: recorded.stage_instance_id, execution_id: recorded.execution_id,
      unit_id: recorded.unit_id, output_name: recorded.output_name,
    }) ?? recorded;
    const producer = await dependencies.contexts.find_for_emit(source.stage_instance_id, source.unit_id);
    if (!producer) continue;
    const release = producer.outputs.find((output) => output.name === source.output_name)?.release;
    if (release?.kind !== "handoff" || release.downstream_role !== context.operator_role) continue;
    const state = await dependencies.get_handoff_state(source.id, producer.execution_workflow_id);
    if (state?.status === "awaiting_downstream" && state.artifact_id === source.id && state.downstream_role === context.operator_role) return { workflow_id: state.command_workflow_id, source_artifact_id: source.id, should_send: true };
    if (consumed_decision_artifact_id && state?.artifact_id === source.id && state.decision_artifact_id === consumed_decision_artifact_id && ["awaiting_external", "revision_requested", "released"].includes(state.status)) {
      return { workflow_id: state.command_workflow_id, source_artifact_id: source.id, should_send: false };
    }
  }
  return null;
};

export const createGateResumeApp = (dependencies: GateResumeDependencies): Hono => {
  const app = new Hono();
  app.post("/gates/:id/resume", async (http) => {
    const compositeId = http.req.param("id");
    const v2WaitId = parseUuidId<WaitId>(compositeId);
    if (v2WaitId && dependencies.records?.decide_gate_wait) {
      let rawBody: unknown;
      try { rawBody = await http.req.json(); } catch { return http.json({ error: "request body must be JSON" }, 400); }
      const request = parseRequest(rawBody);
      if (!request) return http.json({ error: "idempotency_key, artifact_revision_id, gate_step, action, and operator_comment are required strings" }, 400);
      const result = await dependencies.records.decide_gate_wait({ wait_id: v2WaitId, action: request.action,
        actor: "operator", detail: request.feedback ?? request.operator_comment, decided_at: (dependencies.now ?? (() => new Date().toISOString()))() });
      if (result.kind === "wait_not_found") return http.json({ error: result.detail }, 404);
      if (result.kind === "wait_conflict") return http.json({ error: result.detail }, 409);
      await dependencies.send_run_wake?.(result.run_id, `${result.kind}:${result.run_id}:${result.record_version}`).catch(() => undefined);
      return http.json({ gate_id: compositeId, resumed: true }, 202);
    }
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
    // Staleness is a question about this artifact's own coordinate, so it is
    // keyed by the artifact's unit rather than the gate's — they diverge for an
    // artifact collection, where the gate's unit addresses the execution.
    const current = await dependencies.artifacts.find_current({ stage_instance_id: stageId, execution_id: context.execution_id, unit_id: artifact.unit_id, output_name: artifact.output_name });
    if (!current || current.id !== artifact.id) return http.json({ error: "reviewed artifact revision is stale" }, 409);
    if (gate.requires_zero_open_review_items && await dependencies.collaboration.count_open_review_items(artifact.id) > 0) {
      return http.json({ error: "artifact revision has open review items" }, 409);
    }

    // A missing row — including a parked prior attempt's row, which the
    // execution predicate excludes — is the same 409 the reconstructed id's
    // never-started workflow used to produce.
    const state = await dependencies.get_gate_state(artifact.id, request.gate_step, context.execution_workflow_id);
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
    // The guard above admitted only wasConsumed (no send) or a non-null pending
    // state, so the recorded command workflow is in hand exactly when a send is.
    if (!wasConsumed) await dependencies.send_gate_command(state!.command_workflow_id, { kind: "decision", action: request.action, artifact_revision_id: artifact.id, gate_step: request.gate_step }, request.idempotency_key);
    if (handoffTarget?.should_send) await dependencies.send_handoff_command(handoffTarget.workflow_id, { kind: "downstream_decision", action: request.action, decision_artifact_id: artifact.id, feedback: request.feedback ?? request.operator_comment }, request.idempotency_key);
    await dependencies.audits.mark_applied(auditId, (dependencies.now ?? (() => new Date().toISOString()))());
    return http.json({ gate_id: compositeId, resumed: true }, 202);
  });

  /**
   * The v2 gate command: closes the run-owned wait and applies the matching
   * slot release/invalidation atomically, entirely inside `RunRecordRepository`.
   * Unlike the legacy route above, there is no DBOS gate workflow to send a
   * command to — the wait row and the slot transition are the whole fact.
   */
  app.post("/v2/waits/:waitId/resume", async (http) => {
    if (!dependencies.records) return http.json({ error: "v2 wait resume is not configured" }, 501);
    const waitId = parseUuidId<WaitId>(http.req.param("waitId"));
    if (!waitId) return http.json({ error: "wait not found" }, 404);
    let rawBody: unknown;
    try { rawBody = await http.req.json(); } catch { return http.json({ error: "request body must be JSON" }, 400); }
    const request = parseV2WaitResumeRequest(rawBody);
    if (!request) return http.json({ error: "disposition ('release' or 'invalidate') and actor are required" }, 400);
    const decided_at = (dependencies.now ?? (() => new Date().toISOString()))();
    const result = await dependencies.records.close_output_wait({ wait_id: waitId, disposition: request.disposition, actor: request.actor, detail: request.detail, decided_at });
    if (result.kind === "wait_not_found") return http.json({ error: result.detail }, 404);
    if (result.kind === "wait_conflict") return http.json({ error: result.detail }, 409);
    // A hint only ever tells the root "ask again" — sent fire-and-forget,
    // never on the response's critical path.
    await dependencies.send_run_wake?.(result.run_id, `${result.kind}:${result.run_id}:${result.record_version}`).catch(() => undefined);
    if (result.kind === "released") return http.json({ wait_id: waitId, state: "released", artifact_id: result.artifact_id, record_version: result.record_version }, 202);
    if (result.kind === "invalidated") return http.json({ wait_id: waitId, state: "invalidated", record_version: result.record_version }, 202);
    return http.json({ wait_id: waitId, state: "already_applied", record_version: result.record_version }, 202);
  });

  return app;
};
