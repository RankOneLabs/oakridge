import type { OperatorArtifactDetail, OperatorArtifactView, OperatorAttemptView, OperatorBodyValue, OperatorDecisionDefinition, OperatorRunEvent, OperatorRunView, OperatorUnitView, OperatorUnitStatus } from "../operator-contracts";
import type { ArtifactDetail, ArtifactRevision, ArtifactTypeDescriptor, ParkedGate, RepositoryKey, RunDetail, RunEventFrame, RunSessionAttempt, RunStatus, RunSummary, SentReviewFeedback, StageDetail, StageStatus, StageUnit } from "../types";
import { isWebUrl } from "../lib/pr-summary";
import { parseRepositoryKey } from "../repository-inputs";

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
  analysis_body: "dev-spec-analysis-viewer", text: "dev-spec-viewer", plan_body: "dev-plan-viewer", tasks_body: "dev-tasks-viewer", brief_body: "dev-build-brief-viewer",
  build_body: "dev-build-result-viewer", assessment_body: "dev-assessment-viewer", pr_body: "dev-pr-summary-viewer",
};
const SCHEMA_TYPES: Readonly<Record<string, string>> = {
  analysis_body: "dev.spec_analysis", text: "dev.spec", plan_body: "dev.plan", tasks_body: "dev.tasks", brief_body: "dev.build_brief",
  build_body: "dev.build_result", assessment_body: "dev.assessment", pr_body: "dev.pr_summary",
};
/** Keep the prepared repository visible while hiding internal PR watch state. */
export const isVisibleDevelopmentArtifact = (artifact: OperatorArtifactView): boolean =>
  (artifact.artifact_key === "workspace" && artifact.schema === "workspace")
    || (artifact.artifact_key === "spec" && artifact.schema === "text")
    || (artifact.schema !== "text" && Object.hasOwn(SCHEMA_COMPONENTS, artifact.schema) && artifact.artifact_key !== "manual_merge_target");
export const artifactType = (schema: string): ArtifactTypeDescriptor => schema === "workspace"
  ? { id: "workspace", component_id: "", capabilities: { reviewable: false, commentable: false, atom_editable: false, review_items: false }, anchor_schema: null }
  : { id: SCHEMA_TYPES[schema] ?? schema, component_id: SCHEMA_COMPONENTS[schema] ?? "",
    capabilities: { reviewable: true, commentable: true, atom_editable: true, review_items: true }, anchor_schema: null };
export const artifactTypes = (): ArtifactTypeDescriptor[] => Object.keys(SCHEMA_COMPONENTS).map(artifactType);
export const artifactId = (artifact: OperatorArtifactView): string => compositeId({ kind: "artifact", runId: artifact.run_id, unitId: artifact.unit_id, name: artifact.artifact_key });
export const artifactRevisionId = (artifact: OperatorArtifactView, revisionId: string): string =>
  compositeId({ kind: "artifact", runId: artifact.run_id, unitId: artifact.unit_id, name: `${artifact.artifact_key}:${revisionId}` });
export const artifactKeyFromComposite = (name: string): string => name.split(":", 1)[0];
export const objectValue = (value: unknown): { readonly [key: string]: unknown } | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as { readonly [key: string]: unknown } : null;
export const textValue = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
/** The unit view includes the latest revision body, so merge links need no
 * extra artifact request. Only web URLs become clickable in frozen v1 views. */
export const developmentPullRequestUrl = (unit: OperatorUnitView): string | null => {
  const body = unit.artifacts.find((artifact) => artifact.artifact_key === "pr")?.latest_revision?.body;
  const url = textValue(objectValue(body)?.pr_url);
  return url && isWebUrl(url) ? url : null;
};
export const repositoryKeyOf = (unit: OperatorUnitView): RepositoryKey | null => {
  const input = objectValue(unit.input);
  const key = textValue(objectValue(input?.repository)?.key) ?? textValue(objectValue(input?.brief)?.repository_key)
    ?? textValue(objectValue(input?.cohort)?.repository_key) ?? textValue(input?.repository_key);
  return key === null ? null : parseRepositoryKey(key);
};
const worktreeOf = (unit: OperatorUnitView): StageUnit["worktree"] => {
  const input = objectValue(unit.input);
  const workspace = objectValue(input?.workspace);
  const forge = objectValue(objectValue(input?.repository)?.forge);
  const path = textValue(workspace?.repository_path), branch = textValue(workspace?.head), base_ref = textValue(forge?.build_base);
  return path && branch && base_ref ? { path, branch, base_ref } : null;
};
export const revisionToArtifact = (artifact: OperatorArtifactDetail, unit: OperatorUnitView): AdapterResult<ArtifactDetail> => {
  if (artifact.run_id !== unit.run_id || artifact.unit_id !== unit.unit_id)
    return fail("revision to artifact", "artifact does not belong to unit");
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
    run_id: artifact.run_id, original_spec: artifact.original_spec ?? null,
    producing_stage: unit.stage ?? "", label: unit.collection_key ?? unit.unit_key, revisions });
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

/** Aggregate child run statuses before cancellation is projected to a failed stage unit. */
export function selectAggregateStatus(statuses: readonly RunStatus[]): StageStatus {
  if (statuses.includes("failed")) return "failed";
  const unfinished = statuses.filter((status) => status !== "complete" && status !== "cancelled");
  if (unfinished.includes("running")) return "running";
  if (unfinished.includes("parked")) return "parked";
  // A stage has no cancelled status; show a cancelled child as failed once no work is live.
  if (statuses.includes("cancelled")) return "failed";
  if (statuses.length > 0 && statuses.every((status) => status === "complete")) return "complete";
  return "pending";
}

export interface GateDecision { readonly action: string; readonly decision: OperatorDecisionDefinition }
/** Approve-effect keys the frozen gate UI labels and styles as primary; any other key would render as its raw text. */
const V1_APPROVE_ACTIONS: ReadonlySet<string> = new Set(["approve", "confirm_merged", "pass"]);
/** The assessment's builder handoff records this decision with the composed
 * next actions as its feedback, so the gate does not offer it as a bare button. */
export const isDisplayedReviewDecision = (review: string, decision: string): boolean =>
  review !== "assessment_review" || decision !== "request_build_changes";
export const decisionAction = (decision: OperatorDecisionDefinition): string => {
  if (decision.submit.kind === "retry") return "rerun";
  if (decision.submit.kind === "cancel") return "fail";
  if (decision.submit.review === "assessment_review" && decision.submit.effect === "request_changes")
    return decision.submit.decision;
  if (decision.submit.effect === "request_changes") return "request_revision";
  return V1_APPROVE_ACTIONS.has(decision.submit.decision) ? decision.submit.decision : "approve";
};
export const reviewDecisions = (unit: OperatorUnitView): GateDecision[] => unit.decisions
  .filter((decision) => decision.submit.kind === "review"
    && isDisplayedReviewDecision(decision.submit.review, decision.submit.decision))
  .map((decision) => ({ action: decisionAction(decision), decision }));
/** The frozen sidebar matches gates to sessions by stage and unit label. The
 * development cohort runs builder and assessor in separate sessions on one
 * v2 unit, so its reviews must use the session that owns the operator handoff. */
const developmentReviewSession = (unit: OperatorUnitView, review: string): { readonly stage: string; readonly unit: string } => {
  if (unit.stage === "cohort" && review === "assessment_review")
    return { stage: "assessment", unit: unit.collection_key ?? unit.unit_key };
  if (unit.stage === "cohort" && (review === "merge_confirmation" || review === "pr_closed"))
    return { stage: "builder", unit: unit.collection_key ?? unit.unit_key };
  if (unit.stage === "brief" && review === "brief_review")
    return { stage: "brief", unit: "shared writer" };
  return { stage: unit.stage ?? unit.label, unit: unit.collection_key ?? unit.unit_key };
};
export function reviewToGates(unit: OperatorUnitView): AdapterResult<ParkedGate[]> {
  const byReview = new Map<string, OperatorDecisionDefinition[]>();
  for (const decision of unit.decisions) {
    if (decision.submit.kind !== "review") continue;
    if (!isDisplayedReviewDecision(decision.submit.review, decision.submit.decision)) continue;
    byReview.set(decision.submit.review, [...(byReview.get(decision.submit.review) ?? []), decision]);
  }
  return ok([...byReview].map(([review, decisions]) => {
    const session = developmentReviewSession(unit, review);
    const target = decisions[0].submit;
    const artifact = target.kind === "review" ? unit.artifacts.find((candidate) => candidate.latest_revision?.id === target.target_revision_id) : null;
    const id = compositeId({ kind: "gate", runId: unit.run_id, unitId: unit.unit_id, name: review });
    return { id, gate_type: review.includes("merge") ? "merge_confirmation" : artifact ? "artifact_approval" : "gate_decision",
      gate_step: review, run_id: unit.run_id, stage_name: session.stage, unit_id: session.unit,
      artifact_revision_id: target.kind === "review"
        ? artifact ? artifactRevisionId(artifact, target.target_revision_id) : target.target_revision_id
        : null,
      worktree: null, resume_actions: [...new Set(decisions.map(decisionAction))],
      pr_url: review === "merge_confirmation" ? developmentPullRequestUrl(unit) : null,
      run_state: unit.status.kind === "done" ? "succeeded" : unit.status.kind === "cancelled" ? "cancelled" : "active", actionable: true };
  }));
}

const feedbackOf = (payload: OperatorBodyValue): string | null => {
  if (typeof payload !== "object" || payload === null || !("feedback" in payload)) return null;
  const feedback = payload.feedback;
  return typeof feedback === "string" && feedback.trim() ? feedback : null;
};
/** Changes requested on a revision that is still its artifact's latest: sent, and not yet answered by a new revision. */
export function sentReviewFeedback(unit: OperatorUnitView): SentReviewFeedback[] {
  const latestRevisionIds = new Set(unit.artifacts.flatMap((artifact) => artifact.latest_revision ? [artifact.latest_revision.id] : []));
  // Oldest first, so each target keeps its latest decision.
  const latestByTarget = new Map(unit.recorded_decisions.map((decision) => [decision.target_revision_id, decision]));
  return [...latestByTarget.values()]
    .filter((decision) => decision.effect === "request_changes" && latestRevisionIds.has(decision.target_revision_id))
    .map((decision) => {
      const session = developmentReviewSession(unit, decision.review);
      return { id: decision.id, run_id: unit.run_id, stage_name: session.stage, unit_id: session.unit, review: decision.review,
        decision: decision.decision, feedback: feedbackOf(decision.payload), sent_at: decision.created_at };
    });
}

export function attemptToWorkOrder(input: { readonly runId: string; readonly stage: string; readonly unit: OperatorUnitView; readonly attempt: OperatorAttemptView }): AdapterResult<RunSessionAttempt> {
  const { runId, stage, unit, attempt } = input;
  if (!attempt.kbbl_session_id) return fail("attempt to work order", "attempt has no session id");
  const reason: RunSessionAttempt["reason"] = attempt.cause.kind === "retry" ? "operator_retry" : attempt.cause.kind === "changes_requested" ? "input_revision" : "initial";
  const work_order_state: RunSessionAttempt["work_order_state"] = attempt.status === "pending" ? "available" : attempt.status === "running" ? "started" : "completed";
  // v1 groups sidebar attempts by (stage_instance_id, unit_id). A v2 cohort
  // runs its builder and assessor on one unit, so give each a display-stage
  // identity; retries of the same worker still group together.
  const unitLabel = unit.collection_key ?? unit.unit_key;
  const sessionStage = stage === "cohort" && attempt.worker === "builder" ? "builder"
    : stage === "cohort" && attempt.worker === "assessor" ? "assessment" : stage;
  // The development brief writer shares one kbbl session across cohort brief
  // units. Naming its sidebar row after the latest unit would imply that the
  // session belongs to that one cohort.
  const sessionUnitId = stage === "brief" && attempt.worker === "writer" ? "shared writer" : unitLabel;
  const display_label = stage === "analysis" && attempt.worker === "author" ? "Spec analysis"
    : stage === "analysis" && attempt.worker === "spec_editor" ? "Spec update" : sessionStage;
  return ok({ work_order_id: attempt.id, session_id: attempt.kbbl_session_id,
    stage_instance_id: compositeId({ kind: "stage", runId, unitId: unit.unit_id, name: sessionStage }), stage_key: sessionStage,
    display_label, unit_id: sessionUnitId, reason, work_order_state, created_at: attempt.created_at,
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

/** A scalar stage's one unit has no collection key; the PWA names it "0", as every stage-scoped consumer expects. */
export const SCALAR_STAGE_UNIT_ID = "0";

export function unitToStages(units: readonly OperatorUnitView[]): AdapterResult<StageDetail[]> {
  const stages = new Map<string, OperatorUnitView[]>();
  for (const unit of units) if (unit.stage) stages.set(unit.stage, [...(stages.get(unit.stage) ?? []), unit]);
  return ok([...stages].map(([name, members]) => {
    const statuses = members.map((unit) => deriveStatus(statusInputOf(unit)).run);
    const status = selectAggregateStatus(statuses);
    const stageUnits: StageUnit[] = members.map((unit) => {
      return { unit_id: unit.collection_key ?? SCALAR_STAGE_UNIT_ID, sid: unit.attempts.find((attempt) => attempt.is_current)?.kbbl_session_id ?? null,
        repository_key: repositoryKeyOf(unit) as StageUnit["repository_key"],
        params: { unit_id: unit.collection_key ?? unit.unit_key, artifact: objectValue(unit.input)?.brief ?? unit.input },
        worktree: worktreeOf(unit), status: deriveStatus(statusInputOf(unit)).stage,
        gate: reviewGateId(unit), is_retryable: unit.decisions.some((decision) => decision.submit.kind === "retry") };
    });
    return { stage_instance_id: compositeId({ kind: "stage", runId: members[0].run_id, unitId: members[0].unit_id, name }), name, type: name,
      status, artifacts: members.flatMap((unit) => unit.artifacts.filter((artifact) => artifact.latest_revision
        && isVisibleDevelopmentArtifact(artifact)).map((artifact) => ({
        id: artifactId(artifact), type_id: artifactType(artifact.schema).id, version: artifact.revision_count,
        label: unit.collection_key ?? unit.unit_key, created_at: artifact.latest_revision!.created_at }))),
      delegated_kbbl_sid: members.flatMap((unit) => unit.attempts.map((attempt) => attempt.kbbl_session_id)).find((sid) => sid) ?? null,
      worktree: worktreeOf(members[0]), units: stageUnits };
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
  const childStatuses = units.filter((unit) => unit.stage !== null).map((unit) => deriveStatus(statusInputOf(unit)).run);
  const rootStatus = deriveStatus({ status: run.status, attention: null, attempts: [], decisions: [] }).run;
  const hasFailedUnit = unitStatuses.includes("failed");
  const isStuck = rootStatus === "running" && hasFailedUnit;
  const hasLiveChild = childStatuses.some((status) => status !== "complete" && status !== "cancelled");
  const status: RunStatus = rootStatus === "cancelled" ? "cancelled"
    : isStuck ? "running" : hasLiveChild ? selectAggregateStatus(childStatuses) : rootStatus;
  const root = units.find((unit) => unit.stage === null);
  const input = objectValue(root?.input);
  const repositories = Array.isArray(input?.repositories) ? input.repositories : [];
  const repository_keys = repositories.flatMap((value): string[] => { const key = textValue(objectValue(value)?.key); return key ? [key] : []; });
  return ok({ id: run.run_id, title: textValue(input?.title), repository_keys, workflow_name: root?.label ?? run.definition_bundle_id, status,
    stages: grouped.value, parked_count: childStatuses.filter((item) => item === "parked").length,
    updated_at: run.updated_at, is_stuck: isStuck, epic_profile: null });
}
export function runSummary(detail: RunDetail, run: OperatorRunView): RunSummary {
  const completed = detail.stages.filter((stage) => stage.status === "complete").length;
  return { id: detail.id, title: detail.title, repository_keys: detail.repository_keys, workflow_name: detail.workflow_name,
    status: detail.status, current_stage: detail.stages.find((stage) => stage.status !== "complete")?.name ?? null,
    stage_total: detail.stages.length, stage_complete: completed, parked_count: detail.parked_count,
    updated_at: detail.updated_at, is_stuck: detail.is_stuck, is_failed: detail.status === "failed", archived: run.archived_at !== null };
}

// A turn can end while its unit is still active, stalled, or awaiting review.
const EVENT_OPERATIONS = { launched: "stage_materialized", worker_started: "work_started", worker_ended: null,
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
