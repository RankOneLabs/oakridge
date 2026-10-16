import type { OperatorArtifactDetail, OperatorArtifactView, OperatorAttemptView, OperatorDecisionDefinition, OperatorRunEvent, OperatorRunView, OperatorUnitView, OperatorUnitStatus } from "../operator-contracts";
import type { ArtifactDetail, ArtifactRevision, ArtifactTypeDescriptor, ParkedGate, RunDetail, RunEventFrame, RunSessionAttempt, RunStatus, RunSummary, StageDetail, StageStatus, StageUnit } from "../types";

export type AdapterResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly operation: string; readonly detail: string } };
export const ok = <T>(value: T): AdapterResult<T> => ({ ok: true, value });
export const fail = (operation: string, detail: string): AdapterResult<never> => ({ ok: false, error: { operation, detail } });
export const unwrap = <T>(path: string, result: AdapterResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`oakridge ${path}: ${result.error.operation}: ${result.error.detail}`);
};

/** Each part is URI encoded; the vertical bar never appears in an encoded part. */
export type CompositeKind = "artifact" | "gate" | "stage";
export interface CompositeId { readonly kind: CompositeKind; readonly runId: string; readonly unitId: string; readonly name: string }
export const compositeId = ({ kind, runId, unitId, name }: CompositeId): string =>
  ["v2", kind, runId, unitId, name].map(encodeURIComponent).join("|");
export function parseCompositeId(value: string, expected: CompositeKind): AdapterResult<CompositeId> {
  const parts = value.split("|");
  if (parts.length !== 5 || parts[0] !== "v2" || parts[1] !== expected)
    return fail("parse composite id", `expected a v2 ${expected} id`);
  try {
    const [, kind, runId, unitId, name] = parts.map(decodeURIComponent);
    if (!runId || !unitId || !name) return fail("parse composite id", "empty id component");
    return ok({ kind: kind as CompositeKind, runId, unitId, name });
  } catch { return fail("parse composite id", "invalid encoded id component"); }
}

const SCHEMA_COMPONENTS: Readonly<Record<string, string>> = {
  analysis_body: "dev-spec-analysis-viewer", plan_body: "dev-plan-viewer", brief_body: "dev-build-brief-viewer",
  build_body: "dev-build-result-viewer", assessment_body: "dev-assessment-viewer", pr_body: "dev-pr-summary-viewer",
};
const SCHEMA_TYPES: Readonly<Record<string, string>> = {
  analysis_body: "dev.spec_analysis", plan_body: "dev.plan", brief_body: "dev.build_brief",
  build_body: "dev.build_result", assessment_body: "dev.assessment", pr_body: "dev.pr_summary",
};
/** Internal workflow evidence is addressable by a gate, but is not a separate v1 artifact. */
export const isVisibleDevelopmentArtifact = (artifact: OperatorArtifactView): boolean =>
  Object.hasOwn(SCHEMA_COMPONENTS, artifact.schema) && artifact.artifact_key !== "manual_merge_target";
export const artifactType = (schema: string): ArtifactTypeDescriptor => ({
  id: SCHEMA_TYPES[schema] ?? schema, component_id: SCHEMA_COMPONENTS[schema] ?? "",
  capabilities: { reviewable: true, commentable: true, atom_editable: true, review_items: true }, anchor_schema: null,
});
export const artifactTypes = (): ArtifactTypeDescriptor[] => Object.keys(SCHEMA_COMPONENTS).map(artifactType);
export const artifactId = (artifact: OperatorArtifactView): string => compositeId({ kind: "artifact", runId: artifact.run_id, unitId: artifact.unit_id, name: artifact.artifact_key });
export const artifactRevisionId = (artifact: OperatorArtifactView, revisionId: string): string =>
  compositeId({ kind: "artifact", runId: artifact.run_id, unitId: artifact.unit_id, name: `${artifact.artifact_key}:${revisionId}` });
export const artifactKeyFromComposite = (name: string): string => name.split(":", 1)[0];
const objectValue = (value: unknown): { readonly [key: string]: unknown } | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as { readonly [key: string]: unknown } : null;
const textValue = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const repositoryKeyOf = (unit: OperatorUnitView): string | null => {
  const input = objectValue(unit.input);
  return textValue(objectValue(input?.repository)?.key) ?? textValue(objectValue(input?.brief)?.repository_key)
    ?? textValue(objectValue(input?.cohort)?.repository_key);
};
const worktreeOf = (unit: OperatorUnitView): StageUnit["worktree"] => {
  const input = objectValue(unit.input);
  const workspace = objectValue(input?.workspace);
  const forge = objectValue(objectValue(input?.repository)?.forge);
  const path = textValue(workspace?.repository_path), branch = textValue(workspace?.head), base_ref = textValue(forge?.build_base);
  return path && branch && base_ref ? { path, branch, base_ref } : null;
};
export const revisionToArtifact = (artifact: OperatorArtifactDetail): AdapterResult<ArtifactDetail> => {
  const descriptor = artifactType(artifact.schema);
  const revisions: ArtifactRevision[] = artifact.revisions.map((revision) => ({ id: compositeId({ kind: "artifact", runId: artifact.run_id,
    unitId: artifact.unit_id, name: `${artifact.artifact_key}:${revision.id}` }),
    status: artifact.decisions.some((decision) => decision.target_revision_id === revision.id && decision.effect === "request_changes") ? "rejected"
      : artifact.decisions.some((decision) => decision.target_revision_id === revision.id && decision.effect === "approve") ? "approved" : "draft",
    body: revision.body, created_at: revision.created_at, validation: null }));
  return ok({ id: compositeId({ kind: "artifact", runId: artifact.run_id, unitId: artifact.unit_id, name: artifact.artifact_key }),
    type_id: descriptor.id, component_id: descriptor.component_id,
    capabilities: { ...descriptor.capabilities, reviewable: artifact.is_reviewable, atom_editable: artifact.is_editable },
    anchor_schema: descriptor.anchor_schema,
    run_id: artifact.run_id, producing_stage: "", revisions });
};

export interface StatusInput { readonly status: OperatorUnitStatus; readonly attention: OperatorUnitView["attention"]; readonly attempts: readonly OperatorAttemptView[];
  readonly decisions: readonly OperatorDecisionDefinition[]; readonly hasRunStall?: boolean; readonly hasManualMergeFallback?: boolean }
export const statusInputOf = (unit: OperatorUnitView): StatusInput =>
  ({ status: unit.status, attention: unit.attention, attempts: unit.attempts, decisions: unit.decisions,
    hasManualMergeFallback: unit.artifacts.some((artifact) => artifact.artifact_key === "observed_state") });
/** A wait the operator can clear: the unit offers a review decision, rather than waiting on an upstream dependency. */
const awaitsOperator = (decisions: readonly OperatorDecisionDefinition[]): boolean =>
  decisions.some((decision) => decision.submit.kind === "review");
/** An unavailable PR watcher must not hide a manual merge confirmation that can finish the cohort. */
const awaitsManualMergeAfterWatchFailure = (input: StatusInput): boolean => {
  if (!input.hasManualMergeFallback || input.attention?.kind !== "stalled"
    || !input.attention.detail.startsWith("pr_watch failed:")) return false;
  const failures = input.attempts.filter((attempt) => attempt.is_current && attempt.failure);
  return failures.length > 0 && failures.every((attempt) => attempt.worker === "pr_watch"
    && (attempt.failure?.code === "invalid_instruction" || attempt.failure?.code === "discovery_unsupported"))
    && input.decisions.some((decision) => decision.submit.kind === "review"
      && decision.submit.review === "merge_confirmation" && decision.submit.decision === "confirm_merged");
};
export function deriveStatus(input: StatusInput): { readonly run: RunStatus; readonly stage: StageStatus } {
  const { status, attention, attempts, decisions, hasRunStall } = input;
  if (status.kind === "done") return { run: "complete", stage: "complete" };
  if (status.kind === "cancelled") return { run: "cancelled", stage: "failed" };
  if (!hasRunStall && awaitsManualMergeAfterWatchFailure(input)) return { run: "parked", stage: "parked" };
  if (hasRunStall || attention?.kind === "stalled")
    return { run: "failed", stage: "failed" };
  if (attention?.kind === "waiting" && awaitsOperator(decisions)) return { run: "parked", stage: "parked" };
  if (attempts.some((attempt) => attempt.is_current && attempt.failure)) return { run: "failed", stage: "failed" };
  if (status.kind === "active") return { run: "running", stage: "running" };
  return { run: "pending", stage: "pending" };
}

export interface GateDecision { readonly action: string; readonly decision: OperatorDecisionDefinition }
/** Approve-effect keys the frozen gate UI labels and styles as primary; any other key would render as its raw text. */
const V1_APPROVE_ACTIONS: ReadonlySet<string> = new Set(["approve", "confirm_merged", "pass"]);
export const decisionAction = (decision: OperatorDecisionDefinition): string => {
  if (decision.submit.kind === "retry") return "rerun";
  if (decision.submit.kind === "cancel") return "fail";
  if (decision.submit.effect === "request_changes") return "request_revision";
  return V1_APPROVE_ACTIONS.has(decision.submit.decision) ? decision.submit.decision : "approve";
};
export const reviewDecisions = (unit: OperatorUnitView): GateDecision[] => unit.decisions
  .filter((decision) => decision.submit.kind === "review")
  .map((decision) => ({ action: decisionAction(decision), decision }));
export function reviewToGates(unit: OperatorUnitView): AdapterResult<ParkedGate[]> {
  const byReview = new Map<string, OperatorDecisionDefinition[]>();
  for (const decision of unit.decisions) {
    if (decision.submit.kind !== "review") continue;
    byReview.set(decision.submit.review, [...(byReview.get(decision.submit.review) ?? []), decision]);
  }
  return ok([...byReview].map(([review, decisions]) => {
    const target = decisions[0].submit;
    const artifact = target.kind === "review" ? unit.artifacts.find((candidate) => candidate.latest_revision?.id === target.target_revision_id) : null;
    const id = compositeId({ kind: "gate", runId: unit.run_id, unitId: unit.unit_id, name: review });
    return { id, gate_type: review.includes("merge") ? "merge_confirmation" : artifact ? "artifact_approval" : "gate_decision",
      gate_step: review, run_id: unit.run_id, stage_name: unit.stage ?? unit.label, unit_id: unit.collection_key ?? unit.unit_key,
      artifact_revision_id: target.kind === "review"
        ? artifact ? artifactRevisionId(artifact, target.target_revision_id) : target.target_revision_id
        : null,
      worktree: null, resume_actions: [...new Set(decisions.map(decisionAction))],
      run_state: unit.status.kind === "done" ? "succeeded" : unit.status.kind === "cancelled" ? "cancelled" : "active", actionable: true };
  }));
}

export function attemptToWorkOrder(input: { readonly runId: string; readonly stage: string; readonly unit: OperatorUnitView; readonly attempt: OperatorAttemptView }): AdapterResult<RunSessionAttempt> {
  const { runId, stage, unit, attempt } = input;
  if (!attempt.kbbl_session_id) return fail("attempt to work order", "attempt has no session id");
  const reason: RunSessionAttempt["reason"] = attempt.cause.kind === "retry" ? "operator_retry" : attempt.cause.kind === "changes_requested" ? "input_revision" : "initial";
  const work_order_state: RunSessionAttempt["work_order_state"] = attempt.status === "pending" ? "available" : attempt.status === "running" ? "started" : "completed";
  // v1 groups sidebar attempts by (stage_instance_id, unit_id). A v2 cohort
  // runs its builder and assessor on one unit, so include the worker in this
  // display identity; retries of the same worker still group together.
  const unitLabel = unit.collection_key ?? unit.unit_key;
  const sessionUnitId = stage === "cohort" ? `${unitLabel} / ${attempt.worker}` : unitLabel;
  return ok({ work_order_id: attempt.id, session_id: attempt.kbbl_session_id,
    stage_instance_id: compositeId({ kind: "stage", runId, unitId: unit.unit_id, name: stage }), stage_key: stage,
    unit_id: sessionUnitId, reason, work_order_state, created_at: attempt.created_at,
    completed_at: null, executor_health_kind: attempt.failure?.code ?? null, cleanup_state: "not_needed" });
}

/** v2 may run several attempts in one resumable kbbl session. The v1 sidebar
 * names sessions, so retain only the latest attempt for each physical sid.
 * The unit view orders attempts by their creation, oldest first. */
export function latestAttemptPerSession(attempts: readonly OperatorAttemptView[]): AdapterResult<readonly OperatorAttemptView[]> {
  const lastIndexBySession = new Map<string, number>();
  attempts.forEach((attempt, index) => {
    if (attempt.kbbl_session_id) lastIndexBySession.set(attempt.kbbl_session_id, index);
  });
  return ok(attempts.filter((attempt, index) => attempt.kbbl_session_id !== null
    && lastIndexBySession.get(attempt.kbbl_session_id) === index));
}

/** A shared v2 session can carry turns from different collection members.
 * Choose its latest attempt across the whole run before populating the v1 sidebar. */
export function latestUnitAttemptPerSession(units: readonly OperatorUnitView[]): AdapterResult<readonly { readonly unit: OperatorUnitView;
  readonly attempt: OperatorAttemptView }[]> {
  const ordered = units.flatMap((unit) => unit.attempts.map((attempt) => ({ unit, attempt })))
    .filter(({ attempt }) => attempt.kbbl_session_id !== null)
    .sort((left, right) => left.attempt.created_at.localeCompare(right.attempt.created_at) || left.attempt.id.localeCompare(right.attempt.id));
  const latest = new Map<string, { readonly unit: OperatorUnitView; readonly attempt: OperatorAttemptView }>();
  ordered.forEach((entry) => { if (entry.attempt.kbbl_session_id) latest.set(entry.attempt.kbbl_session_id, entry); });
  return ok([...latest.values()]);
}

/** The development cohort's optional admission review is distinct from its
 * Brief review. A pending admission leaves the builder unstarted, which is the
 * v1 StageUnit state that exposes the frozen Admit build control. */
export function developmentAdmission(unit: OperatorUnitView): Pick<StageUnit, "admission_required" | "admitted" | "admission_eligible" | "admission_blocked_by"> {
  const required = objectValue(unit.input)?.admission === true;
  const isWaiting = unit.decisions.some((decision) => decision.submit.kind === "review" && decision.submit.review === "admission");
  const hasBrief = unit.artifacts.some((artifact) => artifact.artifact_key === "brief" && artifact.latest_revision !== null);
  return { admission_required: required, admitted: !required || (hasBrief && !isWaiting),
    admission_eligible: isWaiting, admission_blocked_by: [] };
}

export function unitToStages(units: readonly OperatorUnitView[]): AdapterResult<StageDetail[]> {
  const stages = new Map<string, OperatorUnitView[]>();
  for (const unit of units) if (unit.stage) stages.set(unit.stage, [...(stages.get(unit.stage) ?? []), unit]);
  return ok([...stages].map(([name, members]) => {
    const statuses = members.map((unit) => deriveStatus(statusInputOf(unit)).stage);
    const status: StageStatus = statuses.includes("failed") ? "failed" : statuses.includes("parked") ? "parked"
      : statuses.every((item) => item === "complete") ? "complete" : statuses.includes("running") ? "running" : "pending";
    const stageUnits: StageUnit[] = members.map((unit) => {
      const admission = unit.stage === "cohort" ? developmentAdmission(unit) : null;
      return { unit_id: unit.collection_key ?? unit.unit_key, sid: unit.attempts.find((attempt) => attempt.is_current)?.kbbl_session_id ?? null,
        repository_key: repositoryKeyOf(unit) as StageUnit["repository_key"],
        params: { unit_id: unit.collection_key ?? unit.unit_key, artifact: objectValue(unit.input)?.brief ?? unit.input },
        worktree: worktreeOf(unit), status: admission?.admission_eligible ? "pending" : deriveStatus(statusInputOf(unit)).stage,
        gate: reviewGateId(unit), ...(admission ?? {}) };
    });
    return { stage_instance_id: compositeId({ kind: "stage", runId: members[0].run_id, unitId: members[0].unit_id, name }), name, type: name,
      status, artifacts: members.flatMap((unit) => unit.artifacts.filter((artifact) => artifact.latest_revision
        && isVisibleDevelopmentArtifact(artifact)).map((artifact) => ({
        id: artifactId(artifact), type_id: artifactType(artifact.schema).id, version: artifact.revision_count,
        label: unit.collection_key ?? unit.unit_key, created_at: artifact.latest_revision!.created_at }))),
      delegated_kbbl_sid: members.flatMap((unit) => unit.attempts.map((attempt) => attempt.kbbl_session_id)).find((sid) => sid) ?? null,
      worktree: worktreeOf(members[0]), units: ["prepare", "brief", "cohort", "integration"].includes(name) ? stageUnits : undefined };
  }));
}
const reviewGateId = (unit: OperatorUnitView): string | null => {
  const result = reviewToGates(unit);
  return result.ok ? result.value[0]?.id ?? null : null;
};

export function runSnapshot(run: OperatorRunView, units: readonly OperatorUnitView[]): AdapterResult<RunDetail> {
  if (units.some((unit) => unit.run_id !== run.run_id)) return fail("run snapshot", "unit belongs to another run");
  const grouped = unitToStages(units);
  if (!grouped.ok) return grouped;
  const unitStatuses = units.map((unit) => deriveStatus(statusInputOf(unit)).run);
  const rootStatus = deriveStatus({ status: run.status, attention: null, attempts: [], decisions: [] }).run;
  const status: RunStatus = rootStatus === "cancelled" ? "cancelled"
    : unitStatuses.includes("failed") ? "failed" : unitStatuses.includes("parked") ? "parked" : rootStatus;
  const root = units.find((unit) => unit.stage === null);
  const input = objectValue(root?.input);
  const repositories = Array.isArray(input?.repositories) ? input.repositories : [];
  const repository_keys = repositories.flatMap((value): string[] => { const key = textValue(objectValue(value)?.key); return key ? [key] : []; });
  const updated_at = [...units.flatMap((unit) => [...unit.attempts.map((attempt) => attempt.created_at),
    ...unit.artifacts.flatMap((artifact) => artifact.latest_revision ? [artifact.latest_revision.created_at] : [])]), run.created_at].sort().at(-1)!;
  return ok({ id: run.run_id, title: textValue(input?.title), repository_keys, workflow_name: root?.label ?? run.definition_bundle_id, status,
    stages: grouped.value, parked_count: unitStatuses.filter((item) => item === "parked").length,
    updated_at, is_stuck: status === "failed", epic_profile: null });
}
export function runSummary(detail: RunDetail, run: OperatorRunView): RunSummary {
  const completed = detail.stages.filter((stage) => stage.status === "complete").length;
  return { id: detail.id, title: detail.title, repository_keys: detail.repository_keys, workflow_name: detail.workflow_name,
    status: detail.status, current_stage: detail.stages.find((stage) => stage.status !== "complete")?.name ?? null,
    stage_total: detail.stages.length, stage_complete: completed, parked_count: detail.parked_count,
    updated_at: detail.updated_at, is_stuck: detail.is_stuck, is_failed: detail.status === "failed", archived: run.archived_at !== null };
}

const EVENT_OPERATIONS = { launched: "stage_materialized", worker_started: "work_started", worker_ended: "unit_satisfied",
  revision_published: "slot_released", operator_decided: "gate_decided", retry_requested: "operator_retry_created", cancel_requested: "run_cancelled" } as const;
export function runEventKind(event: OperatorRunEvent): AdapterResult<RunEventFrame | null> {
  const operation = EVENT_OPERATIONS[event.kind];
  if (!operation) return ok(null);
  const payload = { run_id: event.run_id as RunEventFrame["payload"]["run_id"], run_unit_id: event.unit_id,
    stage_instance_id: null, stage_key: null, unit_id: event.unit_key, work_order_id: null, wait_id: null,
    output_name: null, collection_key: null, artifact_revision_id: null, attention: null, continuation: null, detail: null };
  return ok({ sequence: event.event_id, operation, payload, occurred_at: event.occurred_at, replayed: false } as RunEventFrame);
}

/** Frozen brief editors send JSON Pointer anchors to the v2 whole-revision publish route. */
export function replaceJsonPointer(body: unknown, pointer: string, previous: unknown, next: unknown): AdapterResult<unknown> {
  if (!pointer.startsWith("/")) return fail("edit artifact", "anchor is not a JSON Pointer");
  const parts = pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  const copy: unknown = structuredClone(body);
  let parent: unknown = copy;
  for (const part of parts.slice(0, -1)) {
    if (parent === null || typeof parent !== "object") return fail("edit artifact", `anchor ${pointer} is missing`);
    parent = (parent as Record<string, unknown>)[part];
  }
  if (parent === null || typeof parent !== "object") return fail("edit artifact", `anchor ${pointer} is missing`);
  const key = parts.at(-1)!;
  const record = parent as Record<string, unknown>;
  if (JSON.stringify(record[key]) !== JSON.stringify(previous)) return fail("edit artifact", `anchor ${pointer} changed since it was read`);
  record[key] = next;
  return ok(copy);
}
