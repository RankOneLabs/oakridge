import { BLOCKER_ARTIFACT, PROVIDER_ERROR_CODES } from "../operator-contracts/constants";
import { artifactType } from "./artifact-descriptors";
export { artifactType } from "./artifact-descriptors";
import { selectCurrentArtifactContext } from "../lib/current-context";
import { selectReceivedContext, selectRevisionReceivedContext } from "../lib/received-context";
import { artifactSchemaVersion } from "../lib/artifact-version";
import type { OperatorUnitStatus } from "../operator-contracts/core-client/core-types";
import type { OperatorArtifactDetail } from "../operator-contracts/projections/artifact-view";
import type { OperatorRunEvent } from "../operator-contracts/projections/run-event";
import type { OperatorRunView } from "../operator-contracts/projections/run-view";
import type { OperatorArtifactView, OperatorAttemptView, OperatorDecisionDefinition, OperatorOpenReview, OperatorUnitView } from "../operator-contracts/projections/unit-view";
import type { ArtifactDetail, ArtifactRevision } from "../artifact-types";
import type { RepositoryKey, RunDetail, RunEventFrame, RunSessionAttempt, RunStatus, RunSummary, StageDetail, StageStatus, StageUnit } from "../run-types";
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

export const isVisibleArtifact = (artifact: OperatorArtifactView): boolean =>
  artifact.kind !== "status_record" && artifact.artifact_key !== BLOCKER_ARTIFACT;
export const artifactId = (artifact: OperatorArtifactView): string => compositeId({ kind: "artifact", runId: artifact.run_id, unitId: artifact.unit_id, name: artifact.artifact_key });
export const artifactRevisionId = (artifact: OperatorArtifactView, revisionId: string): string =>
  compositeId({ kind: "artifact", runId: artifact.run_id, unitId: artifact.unit_id, name: `${artifact.artifact_key}:${revisionId}` });
export const artifactKeyFromComposite = (name: string): string => name.split(":", 1)[0];
export const objectValue = (value: unknown): { readonly [key: string]: unknown } | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as { readonly [key: string]: unknown } : null;
export const textValue = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
/** The unit view includes the latest revision body, so merge links need no
 * extra artifact request. Only web URLs become clickable in frozen v1 views. */
export const selectReviewPullRequestUrl = (unit: OperatorUnitView, review: OperatorOpenReview | null): string | null => {
  if (review?.confirms !== "merge") return null;
  const artifact = unit.artifacts.find((candidate) => candidate.artifact_key === review.of_artifact && candidate.kind === "external_reference");
  if (!artifact?.link_field) return null;
  const url = textValue(objectValue(artifact.latest_revision?.body)?.[artifact.link_field]);
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
  const descriptor = artifactType(unit.stage, artifact);
  const revisions: ArtifactRevision[] = artifact.revisions.map((revision) => ({ id: compositeId({ kind: "artifact", runId: artifact.run_id,
    unitId: artifact.unit_id, name: `${artifact.artifact_key}:${revision.id}` }),
    status: artifact.decisions.some((decision) => decision.target_revision_id === revision.id && decision.effect === "request_changes") ? "rejected"
      : artifact.decisions.some((decision) => decision.target_revision_id === revision.id && decision.effect === "approve") ? "approved" : "draft",
    context: selectCurrentArtifactContext(unit, revision.attempt_id), received_context: selectRevisionReceivedContext(unit, revision.attempt_id), artifact_schema_version: artifactSchemaVersion(revision), component_id: artifact.view,
    subject_revision_id: revision.subject_id, producing_attempt_inputs: revision.producing_attempt_inputs, body: revision.body, created_at: revision.created_at, validation: null }));
  return ok({ id: compositeId({ kind: "artifact", runId: artifact.run_id, unitId: artifact.unit_id, name: artifact.artifact_key }),
    schema: artifact.schema, artifact_schema_version: artifactSchemaVersion(artifact.revisions.at(-1)),
    context: selectCurrentArtifactContext(unit), received_context: selectReceivedContext(unit), type_id: descriptor.id, component_id: descriptor.component_id,
    capabilities: { ...descriptor.capabilities, reviewable: artifact.is_reviewable, atom_editable: artifact.is_editable },
    anchor_schema: descriptor.anchor_schema,
    run_id: artifact.run_id, link_field: unit.artifacts.find((entry) => entry.artifact_key === artifact.artifact_key)?.link_field ?? null, producing_attempt_inputs: artifact.producing_attempt_inputs,
    projected_workers: unit.workers, producing_stage: unit.stage ?? "", label: unit.collection_key ?? unit.unit_key, revisions });
};

export interface StatusInput { readonly status: OperatorUnitStatus; readonly attention: OperatorUnitView["attention"]; readonly attempts: readonly OperatorAttemptView[];
  readonly decisions: readonly OperatorDecisionDefinition[]; readonly hasRunStall?: boolean; readonly hasManualMergeFallback?: boolean }
export const statusInputOf = (unit: OperatorUnitView): StatusInput =>
  ({ status: unit.status, attention: unit.attention, attempts: unit.attempts, decisions: unit.decisions,
    hasManualMergeFallback: (unit.reviews ?? []).some((review) => review.confirms === "merge") });
/** A wait the operator can clear: the unit offers a review decision, rather than waiting on an upstream dependency. */
const awaitsOperator = (decisions: readonly OperatorDecisionDefinition[]): boolean =>
  decisions.some((decision) => decision.submit.kind === "review");
/** An unavailable PR watcher must not hide a manual merge confirmation that can finish the cohort. */
export const isMergeWatchFailure = (code: string | null | undefined): boolean =>
  code === PROVIDER_ERROR_CODES.invalid_instruction || code === PROVIDER_ERROR_CODES.discovery_unsupported;
const awaitsManualMergeAfterWatchFailure = (input: StatusInput): boolean =>
  Boolean(input.hasManualMergeFallback && input.attention?.kind === "stalled" && isMergeWatchFailure(input.attention.failure_code));
/**
 * An agent session working the unit now. A queued attempt can wait indefinitely, and a code
 * worker (a PR watcher) stays running through transient retries, so neither counts.
 */
const isAgentWorking = (attempt: OperatorAttemptView): boolean =>
  attempt.is_current && attempt.status === "running" && attempt.kbbl_session_id !== null;
/** A stall a failed worker raised, as the authority words it, rather than one the run's commit raised. */
const isWorkerStall = ({ attention, attempts }: StatusInput): boolean => {
  if (attention?.kind !== "stalled") return true;
  return attempts.some((attempt) => attempt.is_current && attempt.failure !== null
    && (attention.failure_code != null
      ? attempt.failure.code === attention.failure_code
      : attention.detail.startsWith(`${attempt.worker} failed:`)));
};
/** One worker failed while an agent still works the unit, so the unit has not stopped. */
const isStillWorkingPastFailure = (input: StatusInput): boolean =>
  !input.hasRunStall && isWorkerStall(input) && input.attempts.some(isAgentWorking);
const failedUnlessStillWorking = (input: StatusInput): { readonly run: RunStatus; readonly stage: StageStatus } =>
  isStillWorkingPastFailure(input) ? { run: "running", stage: "running" } : { run: "failed", stage: "failed" };

export function deriveStatus(input: StatusInput): { readonly run: RunStatus; readonly stage: StageStatus } {
  const { status, attention, attempts, decisions, hasRunStall } = input;
  if (status.kind === "done") return { run: "complete", stage: "complete" };
  if (status.kind === "cancelled") return { run: "cancelled", stage: "failed" };
  if (!hasRunStall && awaitsManualMergeAfterWatchFailure(input)) return { run: "parked", stage: "parked" };
  if (hasRunStall || attention?.kind === "stalled") return failedUnlessStillWorking(input);
  if (attention?.kind === "waiting" && awaitsOperator(decisions)) return { run: "parked", stage: "parked" };
  if (attempts.some((attempt) => attempt.is_current && attempt.failure)) return failedUnlessStillWorking(input);
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

export { isAdjudicationDecision, isDisplayedReviewDecision, selectMergeDecision, selectMergeReview, decisionAction, reviewDecisions, reviewToGates, selectGateDecision, sentReviewFeedback } from "./gates";
import { reviewToGates } from "./gates";

export function attemptToWorkOrder(input: { readonly runId: string; readonly stage: string; readonly unit: OperatorUnitView; readonly attempt: OperatorAttemptView }): AdapterResult<RunSessionAttempt> {
  const { runId, stage, unit, attempt } = input;
  if (!attempt.kbbl_session_id) return fail("attempt to work order", "attempt has no session id");
  const reason: RunSessionAttempt["reason"] = attempt.cause.kind === "retry" ? "operator_retry" : attempt.cause.kind === "changes_requested" ? "input_revision" : "initial";
  const work_order_state: RunSessionAttempt["work_order_state"] = attempt.status === "pending" ? "available" : attempt.status === "running" ? "started" : "completed";
  const unitLabel = unit.collection_key ?? unit.unit_key;
  const display_label = unit.workers?.find((worker) => worker.key === attempt.worker)?.label ?? attempt.worker;
  return ok({ work_order_id: attempt.id, session_id: attempt.kbbl_session_id,
    stage_instance_id: compositeId({ kind: "stage", runId, unitId: unit.unit_id, name: stage }), stage_key: stage,
    display_label, unit_id: unitLabel, reason, work_order_state, created_at: attempt.created_at,
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
 * Keep the latest attempt for each unit and session pair. */
export function latestUnitAttemptPerSession(units: readonly OperatorUnitView[]): AdapterResult<readonly { readonly unit: OperatorUnitView;
  readonly attempt: OperatorAttemptView }[]> {
  const ordered = units.flatMap((unit) => unit.attempts.map((attempt) => ({ unit, attempt })))
    .filter(({ attempt }) => attempt.kbbl_session_id !== null)
    .sort((left, right) => left.attempt.created_at.localeCompare(right.attempt.created_at) || left.attempt.id.localeCompare(right.attempt.id));
  const keys = ordered.map(({ unit, attempt }) => JSON.stringify([unit.unit_id, attempt.kbbl_session_id]));
  const latest = new Map(keys.map((key, index) => [key, index]));
  return ok(ordered.filter((_, index) => latest.get(keys[index]) === index));
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
        && isVisibleArtifact(artifact)).map((artifact) => ({
        id: artifactId(artifact), type_id: artifactType(unit.stage, artifact).id, view: artifact.view, artifact_kind: artifact.kind, version: artifact.revision_count,
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
  return ok({ id: run.run_id, title: textValue(input?.title), repository_keys, workflow_name: root?.label ?? run.definition_id, status,
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


export function parseDefinitionPrompts(value: unknown): AdapterResult<import("../operator-contracts/projections/definition-view").OperatorDefinitionPrompts> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("parse definition prompts", "expected an object");
  const prompts: { [path: string]: import("../operator-contracts/projections/definition-view").OperatorDefinitionPrompt } = {};
  for (const [path, entry] of Object.entries(value)) {
    if (typeof entry !== "object" || entry === null || !("body" in entry) || typeof entry.body !== "string" || !("digest" in entry) || typeof entry.digest !== "string" || !/^[0-9a-f]{64}$/.test(entry.digest)) return fail("parse definition prompts", path + ": expected body text and lowercase SHA-256 digest");
    if (!("includes" in entry) || !Array.isArray(entry.includes) || !entry.includes.every((include: unknown) => typeof include === "string")) return fail("parse definition prompts", path + ": expected the included prompt paths");
    prompts[path] = { body: entry.body, digest: entry.digest, includes: entry.includes };
  }
  return ok(prompts);
}
