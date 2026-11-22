import { ensureKeyedExecution, mutateKeyedExecution } from "./keyed-execution-store";
import { parseAssessmentDecision, resolveCitation, selectPublicationFacts, type AssessmentFactError } from "../domain/assessment-embeddings";
import { assessmentFactId, authorizeDispatch, selectAuthorizationId, validateRecipients } from "../domain/dispatch-policy";
import { renderRoundDelivery } from "../domain/round-delivery";
import { selectCurrentRound, selectRoundProgress } from "../projections/assessment-status";
import { readAssessmentFacts, readRoundAssessment, bindRoundAction, readRoundDelivery, writeAssessmentFacts, type AssessmentFacts, type AssessmentWrites } from "./assessment-facts";
import type { AssessmentDecisionCommand, AssignmentRound, AssignmentUpdate, CompiledWorkflow, DispatchAuthorization,
  DispatchAuthorizationRequest, DispatchOperation, FeedbackAssignment, FeedbackItem, FeedbackItemRequest, FeedbackRejection, ParsedReview, RevisionState, RoundRequest } from "../core-client/core-types";
import { ok, traced } from "../domain/primitives";
import { createHash } from "node:crypto";
import type { CoreClient } from "../core-client/client";
import { compileDefinition, selectWanted, type WantedForUnit } from "../core-client/client";
import { BLOCKER_ARTIFACT, BLOCKER_REVIEW, BLOCKER_REVIEW_PROMPT, VALIDATION_REVIEW, type BlockedReason, type Event, type Incoming, type ParsedReviewDecision, type ParsedWorkflow, type StepSnapshot, type StepResult, type Type, type UnitStatus, type Writer } from "../core-client/core-types";
import { ANALYSIS_LINKS_DECLARED, selectDeclarationRefusal, type AnalysisLinkDeclaration, type AnalysisLinkEntry, type AnalysisLinksDeclared } from "../domain/analysis-link-declaration";
import { selectEffectInstruction, selectSelfAssessmentSubjects, type RunWorkerAction } from "../domain/effect-instruction";
import type { PrIntegration } from "../domain/pr-integration";
import { parseRunConfig, type RunConfig } from "../domain/run-config";
import { isTerminalStatus } from "../domain/unit-status";
import { withReviewHistory, type ReviewHistoryInstruction } from "../effects/session-prompt";
import { renderTemplate } from "../domain/prompt-template";
import type { ActionId, DefinitionId, IngressId, ProjectId, RunId, TracedError, UnitId, Result } from "../domain/primitives";
import type { CommitFaultNotice } from "../projections/operator-event";
import { selectRunEventFields, type RunEvent, type RunEventFields } from "../projections/run-event";
import { selectUnitTree } from "../projections/unit-label";
import { anyOf, jsonText, type Database, type DatabaseTransaction } from "./database";
import type { AssessmentDecisionReceipt, CommitReceipt, ReviewPrompt, ReviewPrompts, StallRecord, WantedWorkers } from "./json-column-types";
import { START_OWED_STATUSES } from "./executor-store";
import { readStepSnapshot } from "./snapshot-store";

/** Parsed client launch settings, excluding the integration and skill pin resolved by the server. */
export interface LaunchRequestContent {
  readonly definition_id: DefinitionId;
  readonly project_id: ProjectId | null;
  readonly config: Pick<RunConfig, "sessions" | "grading_enabled"> | null;
  readonly pr_integration?: PrIntegration;
}
/** An event as ingress hands it over: the writer is resolved from the credential, never the body. */
export interface CommitRequest {
  readonly run_id: RunId;
  readonly ingress_id: string | null;
  readonly event: Event;
  readonly writer: Writer;
  readonly assessment_decision?: unknown;
  readonly execution_reconciliation?: string;
  /** Required with `launched`: the run is created pinned to this definition. */
  readonly launch?: { readonly definition_id: DefinitionId; readonly project_id: ProjectId | null; readonly config: RunConfig | null };
  /**
   * Only with `worker_started`: the sha256 hex of the publication secret minted
   * for the attempt's session. Commit stores it on the attempt, and publish
   * resolves its writer from it (part 1 §7.2).
   */
  readonly publication_secret_hash?: string | null;
  /** HTTP launch identity before server defaults, skill pinning and health checks. */
  readonly launch_request?: LaunchRequestContent;
}
export type CommitOutcome =
  | { readonly kind: "committed"; readonly event_id: string; readonly assessment_decision?: AssessmentDecisionReceipt }
  /** The ingress id was seen before with the same content: its stored result. */
  | { readonly kind: "replayed"; readonly receipt: CommitReceipt }
  /** `step` refused the event. Stored as a rejected receipt when it carries an ingress id. */
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "conflict"; readonly detail: string }
  /** Transient contention (deadlock, serialization failure, a concurrent launch mid-write): the same event can be retried as is. */
  | { readonly kind: "contended"; readonly detail: string }
  | { readonly kind: "missing"; readonly detail: string };
export interface CommitDependencies {
  readonly db: Database;
  readonly core: CoreClient;
  /** Called after a committed event; the executor re-reads the run. */
  readonly wake: (run_id: RunId) => void;
}
export type CommitResult = Result<CommitOutcome, TracedError>;

/** A fault rolls the transaction back; the outer IO boundary records it separately. */
export interface CommitFault { readonly error: TracedError; readonly unit_id: string | null }
/** A pure planning refusal: a step cannot be represented by this storage contract. */
export interface CommitViolation extends TracedError { readonly operation: "select_commit_plan" }
const fault = (run_id: string, detail: string, unit_id: string | null = null): CommitFault =>
  ({ error: { operation: "commit_event", entity_id: run_id, detail }, unit_id });
const violation = (run_id: string, detail: string): Result<never, CommitViolation> =>
  ({ ok: false, error: { operation: "select_commit_plan", entity_id: run_id, detail } });

type GeneratedValue = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };
const generatedFailure = (detail: string): GeneratedValue => ({ ok: false, error: detail });
const objectFields = (value: unknown): { readonly [key: string]: unknown } | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as { readonly [key: string]: unknown } : null;
function resolvedType(type: Type, aliases: ParsedWorkflow["schemas"]): Type {
  let current = type;
  const visited = new Set<string>();
  while (current.kind === "named" && !visited.has(current.schema)) {
    visited.add(current.schema);
    const next = aliases?.[current.schema];
    if (!next) break;
    current = next;
  }
  return current;
}
function collectGeneratedIds(type: Type, value: unknown, aliases: ParsedWorkflow["schemas"], ids: Set<string>): void {
  const resolved = resolvedType(type, aliases);
  if (resolved.kind === "uuid" && resolved.generated && typeof value === "string") ids.add(value);
  if (resolved.kind === "optional" && value !== null) collectGeneratedIds(resolved.value, value, aliases, ids);
  if (resolved.kind === "list" && Array.isArray(value)) for (const item of value) collectGeneratedIds(resolved.item, item, aliases, ids);
  if (resolved.kind === "record") {
    const fields = objectFields(value);
    if (fields) for (const [key, fieldType] of Object.entries(resolved.fields)) collectGeneratedIds(fieldType, fields[key], aliases, ids);
  }
}
/** Fill generated fields recursively. A supplied ID is only valid on an operator edit of its predecessor. */
function enrichGenerated(type: Type, value: unknown, aliases: ParsedWorkflow["schemas"], allowed: ReadonlySet<string>, seen: Set<string> | null = null): GeneratedValue {
  const resolved = resolvedType(type, aliases);
  if (resolved.kind === "uuid" && resolved.generated) {
    const id = value === undefined ? crypto.randomUUID() : value;
    if (typeof id !== "string" || (value !== undefined && !allowed.has(id))) return generatedFailure("generated identity does not belong to the predecessor");
    if (seen?.has(id)) return generatedFailure("duplicate generated identity in one list");
    seen?.add(id);
    return { ok: true, value: id };
  }
  if (resolved.kind === "optional" && (value === undefined || value === null)) return { ok: true, value };
  if (resolved.kind === "optional") return enrichGenerated(resolved.value, value, aliases, allowed, seen);
  if (resolved.kind === "list" && Array.isArray(value)) {
    const listSeen = new Set<string>();
    const items: unknown[] = [];
    for (const item of value) {
      const next = enrichGenerated(resolved.item, item, aliases, allowed, listSeen);
      if (!next.ok) return next;
      items.push(next.value);
    }
    return { ok: true, value: items };
  }
  if (resolved.kind === "record") {
    const fields = objectFields(value);
    if (!fields) return { ok: true, value };
    const output: { [key: string]: unknown } = { ...fields };
    for (const [key, fieldType] of Object.entries(resolved.fields)) {
      const next = enrichGenerated(fieldType, fields[key], aliases, allowed, seen);
      if (!next.ok) return next;
      if (next.value !== undefined) output[key] = next.value;
    }
    return { ok: true, value: output };
  }
  return { ok: true, value };
}

/** Canonical JSON: object keys sorted, so a replay matches regardless of key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as { readonly [key: string]: unknown })[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export interface RequestDigestInput extends Pick<CommitRequest, "writer" | "publication_secret_hash" | "launch_request" | "assessment_decision"> {
  readonly event: Event | AnalysisLinksDeclared;
  readonly launch?: CommitRequest["launch"] | LaunchRequestContent;
}
/** HTTP launches hash client content; internal commits retain their full launch identity. */
export function requestDigest(request: RequestDigestInput): string {
  const { event, writer, publication_secret_hash } = request;
  const launch = request.launch_request ?? request.launch;
  return createHash("sha256").update(canonical({ event, writer, ...(publication_secret_hash ? { publication_secret_hash } : {}),
    ...(launch ? { launch } : {}),
    ...(request.assessment_decision === undefined ? {} : { assessment_decision: request.assessment_decision }) })).digest("hex");
}

/**
 * The single writer of workflow state (part 1 §6.2). Under the run row lock it
 * answers a replayed ingress id from its receipt, steps the core over the
 * step snapshot, and writes the event with its writer, the state delta, the
 * effect instructions for newly wanted workers, the wanted log, the receipt
 * and the operator event, in one transaction. A step rejection is stored, not
 * rolled back. The executor is woken after commit.
 */
type OperatorDecisionEvent = Extract<Event, { readonly kind: "operator_decided" }>;
/** Core checks declared payload values, but permits extra record keys. */
function plainPayloadRefusal(declared: ParsedReviewDecision, event: OperatorDecisionEvent, aliases: ParsedWorkflow["schemas"]): string | null {
  let schema = declared.payload && resolvedType(declared.payload, aliases);
  while (schema?.kind === "optional") schema = resolvedType(schema.value, aliases);
  if (schema && schema.kind !== "record") return null; // Core checks scalar and list payloads.
  if (event.payload == null) return null;
  const values = objectFields(event.payload);
  if (!values) return `${event.target}: plain decision requires an object payload`;
  const extra = Object.keys(values).find(key =>
    !Object.hasOwn(declared.fields ?? {}, key) && !Object.hasOwn(schema?.fields ?? {}, key)
    && !(key === "feedback" && declared.effect === "request_changes" && event.review !== BLOCKER_REVIEW));
  return extra === undefined ? null : `${event.target}: plain decision does not accept payload field ${extra}`;
}

function latestRevision(snapshot: Pick<StepSnapshot, "revisions">, unit: string, artifact: string): RevisionState | undefined {
  return snapshot.revisions.findLast(revision => revision.unit === unit && revision.artifact === artifact);
}

function stageOf(workflow: CompiledWorkflow, snapshot: StepSnapshot, id: string) {
  const unit = snapshot.units.find(value => value.id === id);
  const stage = unit?.kind.kind === "stage" ? unit.kind.stage : null;
  return stage === null ? undefined : workflow.workflow.stages[stage];
}

function assessmentOf(review: ParsedReview, stage: NonNullable<ReturnType<typeof stageOf>>): string | undefined {
  return review.assessment ?? (stage.artifacts?.[review.of]?.kind === "assessment" ? review.of : undefined);
}

function stageAgents(stage: NonNullable<ReturnType<typeof stageOf>>): string[] {
  return Object.entries(stage.workers ?? {}).filter(([, worker]) => worker.kind === "agent").map(([key]) => key);
}

interface AssessmentDecisionInput {
  readonly command: AssessmentDecisionCommand;
  readonly facts: AssessmentFacts;
  readonly snapshot: StepSnapshot;
  readonly workflow: CompiledWorkflow;
  readonly event: OperatorDecisionEvent;
  readonly writer: Writer;
}

interface AssessmentDecisionPlan {
  readonly event: OperatorDecisionEvent;
  readonly assignments: readonly FeedbackAssignment[];
  readonly rejections: readonly Omit<FeedbackRejection, "decision">[];
  readonly approval?: Omit<NonNullable<AssessmentWrites["approval"]>, "decision">;
  readonly rounds: readonly Omit<AssignmentRound, "decision">[];
}

export function selectAssessmentDecisionPlan(input: AssessmentDecisionInput): Result<AssessmentDecisionPlan, AssessmentFactError> {
  const { command, facts, snapshot, workflow, event, writer } = input;
  const refusal = (detail: string) => traced("decide_assessment", event.target, detail);
  if (writer.kind !== "operator") return refusal("assessment decisions require an operator credential");
  if (facts.approval) return refusal("approval is final; it cannot be withdrawn or replaced");
  if (facts.revision !== command.target) return refusal("target is not the latest assessment revision");
  const assessmentIndex = snapshot.revisions.findIndex(revision => revision.id === facts.revision);
  const assessment = snapshot.revisions[assessmentIndex];
  const assessed = snapshot.revisions.find(revision => revision.id === command.assessed_revision);
  if (!assessment || !assessed || assessment.subject !== assessed.id || assessed.unit !== event.unit
    || latestRevision(snapshot, assessed.unit, assessed.artifact)?.id !== assessed.id
    || facts.updates.some(update => snapshot.revisions.findIndex(revision => revision.id === update.revision) > assessmentIndex)) {
    return refusal("assessed work changed since it was read");
  }
  const stage = stageOf(workflow, snapshot, event.unit);
  const review = stage?.reviews?.[event.review];
  const decision = review?.decisions[event.decision];
  if (!stage || !review || !decision || command.decision !== event.decision || command.target !== event.target) {
    return refusal("assessment decision not found");
  }
  if (snapshot.decisions.some(value => value.kind === "validation" && value.target === facts.revision)) {
    return refusal("target revision failed validation");
  }
  const target = latestRevision(snapshot, event.unit, decision.on ?? review.of);
  if (!target) return refusal("dispatch target is unpublished");
  const operation = decision.operation;
  const approving = operation === "approve_assessment";
  if (operation !== "dispatch_feedback" && operation !== "direct_correction" && !approving) return refusal("assessment operation not found");
  const rejections: Omit<FeedbackRejection, "decision">[] = [];
  const assignments: FeedbackAssignment[] = [];
  const rounds: Omit<AssignmentRound, "decision">[] = [];
  const requests: RoundRequest[] = [];
  const disposed = new Set<string>();
  const disposedAssignments = new Set<string>();
  for (const disposition of command.dispositions) {
    const assignment = disposition.kind === "reject_follow_up" ? facts.assignments.find(value => value.id === disposition.assignment) : undefined;
    const id = disposition.kind === "reject_follow_up" ? assignment?.item : disposition.item;
    const item = facts.items.find(value => value.id === id);
    if (!item) return refusal("disposition does not name feedback associated with the assessment");
    if (assignment) {
      if (disposedAssignments.has(assignment.id)) return refusal(`assignment ${assignment.id} has multiple dispositions`);
      disposedAssignments.add(assignment.id);
    } else {
      if (disposed.has(item.id)) return refusal(`feedback item ${item.id} has multiple dispositions`);
      disposed.add(item.id);
    }
    if (facts.rejections.some(value => value.item === item.id && value.assignment == null)) return refusal(`feedback item ${item.id} was rejected`);
    if (disposition.kind === "reject_follow_up" || disposition.kind === "reject") {
      if (disposition.kind === "reject_follow_up") {
        const round = assignment && selectCurrentRound(facts, assignment.id);
        if (!approving || !round || selectRoundProgress(facts, round) !== "returned_for_update") return refusal("only a current needs_further_work follow-up may be rejected on approval");
      } else if (item.origin.kind !== "proposal" || facts.assignments.some(value => value.item === item.id)) {
        return refusal("only an undisposed proposal may be rejected");
      }
      rejections.push({ id: assessmentFactId("fr_", [assessment.id, item.id, assignment?.id ?? ""]), item: item.id,
        assessment_revision: assessment.id, assignment: assignment?.id ?? null, reason: disposition.reason });
      continue;
    }
    if (approving || item.origin.kind !== (operation === "dispatch_feedback" ? "proposal" : "operator")) return refusal("feedback origin does not match the dispatch operation");
    const authorization = authorizeDispatch({ kind: "operator_required" }, { operation, item,
      target: { unit: event.unit, artifact: target.artifact, revision: target.id }, instruction: disposition.instruction,
      recipients: disposition.recipients, stage_agent_workers: stageAgents(stage), authorizations: facts.authorizations });
    if (!authorization.ok) return authorization;
    for (const recipient of authorization.value.recipients) {
      const assignmentId = assessmentFactId("fa_", [item.id, event.unit, target.artifact, recipient]);
      const current = selectCurrentRound(facts, assignmentId);
      const roundId = assessmentFactId("ar_", [assignmentId, authorization.value.id]);
      if (current?.id === roundId) continue;
      if (facts.rounds.some(value => value.id === roundId)) return refusal(`authorization already used for assignment ${assignmentId}`);
      if (current && selectRoundProgress(facts, current) !== "returned_for_update") return refusal(`assignment ${assignmentId} has not been returned for update`);
      assignments.push({ id: assignmentId, item: item.id, target_unit: event.unit, target_artifact: target.artifact, recipient });
      rounds.push({ id: roundId, assignment: assignmentId, ordinal: (current?.ordinal ?? 0) + 1,
        authorization: authorization.value.id, instruction: authorization.value.instruction });
      requests.push({ round: roundId, assignment: assignmentId, worker: recipient });
    }
  }
  if (approving) {
    for (const item of facts.items) {
      const related = facts.assignments.filter(value => value.item === item.id);
      if (related.length === 0 && ![...facts.rejections, ...rejections].some(value => value.item === item.id && value.assignment == null)) {
        return refusal(`readiness refused: proposal ${item.origin.kind === "proposal" ? item.origin.key : item.id} has no disposition`);
      }
      for (const assignment of related) {
        const round = selectCurrentRound(facts, assignment.id);
        const progress = round ? selectRoundProgress(facts, round) : "awaiting_update";
        if (progress === "assessor_verified" || progress === "accepted_by_operator"
          || (progress === "returned_for_update" && rejections.some(value => value.assignment === assignment.id))) continue;
        const reason = progress === "awaiting_update" ? "awaits update" : progress === "awaiting_verification" ? "awaits verification" : "needs further work";
        return refusal(`readiness refused: assignment ${assignment.id} ${reason}`);
      }
    }
    return ok({ event: { ...event, target: target.id, payload: {} }, rounds, rejections, assignments, approval: {
      id: assessmentFactId("aa_", [assessment.id]), unit: facts.unit, assessment_revision: assessment.id,
      assessed_revision: assessed.id, approved_by: writer.subject ?? "local-control",
    } });
  }
  if (!requests.length) return refusal("dispatch requires at least one new round");
  return ok({ event: { ...event, target: target.id, payload: { rounds: requests } }, rounds, rejections, assignments });
}

export async function commitEvent(deps: CommitDependencies, request: CommitRequest,
  within?: (trx: DatabaseTransaction, outcome: CommitOutcome) => Promise<void>): Promise<CommitResult> {
  const scoped = { ...request, ingress_id: scopeIngressId(request.writer, request.ingress_id) };
  let trx: Awaited<ReturnType<ReturnType<Database["startTransaction"]>["execute"]>> | null = null;
  try {
    trx = await deps.db.startTransaction().execute();
    const result = await commitInTransaction(trx, deps.core, scoped);
    if (!result.outcome.ok) {
      await trx.rollback().execute();
      trx = null;
      return { ok: false, error: await recordCommitFault(deps.db, scoped, result.outcome.error) };
    }
    const outcome = result.outcome.value;
    if (result.created && outcome.kind !== "committed") {
      const refusal = outcome.kind === "rejected" ? await readReceipt(trx, scoped) : null;
      await trx.rollback().execute();
      trx = null;
      return await storeLaunchRefusal(deps.db, scoped, { outcome, refusal });
    }
    await within?.(trx, outcome);
    await trx.commit().execute();
    trx = null;
    // A replay wakes too: the original commit's wake may have been lost.
    if (outcome.kind === "committed" || outcome.kind === "replayed") deps.wake(request.run_id);
    return { ok: true, value: outcome };
  } catch (error) {
    if (trx !== null) await trx.rollback().execute().catch(() => undefined);
    const conflict = concurrencyConflict(error);
    if (conflict) return { ok: true, value: { kind: "contended", detail: conflict } };
    return { ok: false, error: { operation: "commit_event", entity_id: request.run_id, detail: String(error) } };
  }
}

/**
 * Ingress ids are chosen by their writer, so each writer gets its own
 * namespace: an operator or an agent cannot claim the id the executor will
 * report an attempt under, and one session cannot claim another's.
 */
export function scopeIngressId(writer: Writer, ingress_id: string | null): IngressId | null {
  if (ingress_id === null) return null;
  switch (writer.kind) {
    case "session": return `session:${writer.session}:${ingress_id}` as IngressId;
    case "operator": case "executor": case "engine": return `${writer.kind}:${ingress_id}` as IngressId;
  }
}

/**
 * A fault rolled its transaction back, so it is recorded against the run in
 * a transaction of its own (D-V4): the run's attention shows it until a later
 * event commits on the unit the event addressed. It is shown on the unit the
 * core was advancing when it found the fault, else that addressed unit. A
 * launch that faulted left no run to record it on. A retried request whose
 * fault still stands is not recorded again: the run row lock serializes the
 * check. Returns the fault, naming a failure to record it.
 */
async function recordCommitFault(db: Database, request: CommitRequest, fault: CommitFault): Promise<TracedError> {
  try {
    await db.transaction().execute(async (trx) => {
      const run = await trx.selectFrom("authority.run").select("id").where("id", "=", request.run_id)
        .where("root_unit_id", "is not", null).forUpdate().executeTakeFirst();
      if (!run) return;
      const affected = await affectedUnit(trx, request.run_id, request.event);
      const addressed = affected.ok ? affected.value : null;
      const after_event = await readLatestEventId(trx, request.run_id, addressed);
      if (request.ingress_id !== null && await isFaultStanding(trx, { run_id: request.run_id, ingress_id: request.ingress_id, after_event })) return;
      const notice: CommitFaultNotice = { run_id: request.run_id, unit_id: addressed as UnitId | null, at_unit: fault.unit_id as UnitId | null,
        ingress_id: request.ingress_id, event: request.event, detail: fault.error.detail, after_event };
      await trx.insertInto("authority.operator_event").values({ id: crypto.randomUUID(), run_id: request.run_id, run_key: request.run_id, payload: jsonText({ kind: "commit_fault", data: notice }) }).execute();
    });
    return fault.error;
  } catch (cause) {
    return { ...fault.error, detail: `${fault.error.detail} (recording the fault failed: ${String(cause)})` };
  }
}

interface FaultIdentity { readonly run_id: string; readonly ingress_id: string; readonly after_event: string | null }
/** Whether this request's fault is already recorded and still stands: nothing has committed on its unit since. */
async function isFaultStanding(trx: DatabaseTransaction, input: FaultIdentity): Promise<boolean> {
  const rows = await trx.selectFrom("authority.operator_event").select("payload").where("run_id", "=", input.run_id)
    .where((eb) => eb(eb.ref("payload", "->>").key("kind"), "=", "commit_fault")).execute();
  return rows.some((row) => row.payload.kind === "commit_fault" && row.payload.data.ingress_id === input.ingress_id
    && row.payload.data.after_event === input.after_event);
}

/** The latest event committed on a unit, or on the run as a whole for null: what a stall or a fault stands after. */
async function readLatestEventId(trx: DatabaseTransaction, run_id: string, unit_id: string | null): Promise<string | null> {
  // A declaration moves no workflow state, so a refused event's stall or fault still stands after one.
  let latest = trx.selectFrom("authority.event").select("id").where("run_id", "=", run_id)
    .where((eb) => eb(eb.ref("payload", "->>").key("kind"), "<>", ANALYSIS_LINKS_DECLARED));
  if (unit_id !== null) latest = latest.where("unit_id", "=", unit_id);
  return (await latest.orderBy("created_at", "desc").orderBy("id", "desc").limit(1).executeTakeFirst())?.id ?? null;
}

/** Deadlock and serialization failures are retryable outcomes, not faults. */
function concurrencyConflict(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  if (error.code === "40P01") return "database deadlock detected (40P01); retry the event";
  if (error.code === "40001") return "database serialization failure (40001); retry the event";
  return null;
}

/**
 * A launch creates its run row before stepping it. A launch that created the
 * row and does not commit (step refused it, or it replays a refused launch)
 * rolls its whole transaction back, so no run is left without a root. Its
 * outcome rides out on this, and a refusal's receipt is stored on its own.
 */
interface TransactionCommit { readonly created: boolean; readonly outcome: Result<CommitOutcome, CommitFault> }
async function commitInTransaction(trx: DatabaseTransaction, core: CoreClient, request: CommitRequest): Promise<TransactionCommit> {
  if (request.event.kind !== "launched") return { created: false, outcome: await commitToRun(trx, core, request) };
  const launch = request.launch;
  if (!launch) return { created: false, outcome: { ok: true, value: { kind: "missing", detail: "a launch names its pinned definition" } } };
  const created = await trx.insertInto("authority.run").values({ id: request.run_id, definition_id: launch.definition_id,
    project_id: launch.project_id, config: launch.config === null ? null : jsonText(launch.config) })
    .onConflict((conflict) => conflict.column("id").doNothing()).returning("id").executeTakeFirst();
  return { created: created !== undefined, outcome: await commitToRun(trx, core, request) };
}

interface StoredReceipt { readonly ingress_id: string; readonly request_digest: string; readonly result: CommitReceipt }
async function readReceipt(db: Database | DatabaseTransaction, request: Pick<CommitRequest, "run_id" | "ingress_id">): Promise<StoredReceipt | null> {
  if (request.ingress_id === null) return null;
  return await db.selectFrom("authority.ingress_receipt").select(["ingress_id", "request_digest", "result"])
    .where("run_id", "=", request.run_id).where("ingress_id", "=", request.ingress_id).executeTakeFirst() ?? null;
}

export interface LaunchReplayRequest {
  readonly run_id: RunId;
  readonly ingress_id: string;
  readonly writer: Writer;
  readonly event: Extract<Event, { readonly kind: "launched" }>;
  readonly launch_request: LaunchRequestContent;
}
/** A receipt is authoritative before consulting today's launchable catalog, defaults or health. */
export async function replayLaunch(db: Database, request: LaunchReplayRequest): Promise<CommitResult | null> {
  const receipt = await readReceipt(db, { ...request, ingress_id: scopeIngressId(request.writer, request.ingress_id) });
  if (!receipt) return null;
  const replayed: CommitResult = { ok: true, value: { kind: "replayed", receipt: receipt.result } };
  if (receipt.request_digest === requestDigest(request)) return replayed;
  // Compatibility for receipts written before HTTP client identity was separated from server pins.
  const run = await db.selectFrom("authority.run").select("config").where("id", "=", request.run_id).executeTakeFirst();
  const recorded = run ? parseRunConfig(run.config ?? {}) : null;
  const client = request.launch_request;
  if (run && recorded && (client.pr_integration === undefined || client.pr_integration === recorded.pr_integration)) {
    const settings = parseRunConfig(client.config ?? {})!;
    const config = run.config === null ? client.config : {
      sessions: settings.sessions, grading_enabled: settings.grading_enabled,
      ...("pr_integration" in run.config ? { pr_integration: recorded.pr_integration } : {}),
      ...("pr_skill_digest" in run.config ? { pr_skill_digest: recorded.pr_skill_digest } : {}),
    };
    const legacy = { event: request.event, writer: request.writer,
      launch: { definition_id: client.definition_id, project_id: client.project_id, config } };
    if (receipt.request_digest === requestDigest(legacy)) return replayed;
  }
  return { ok: true, value: { kind: "conflict", detail: "ingress id reused with different content" } };
}

/**
 * A refused launch's receipt, stored once its transaction has rolled the run
 * row back. With no run row there is no lock to serialize on: a concurrent
 * launch of the same request may have stored the receipt first, and then
 * this one answers from it as a replay would.
 */
async function storeLaunchRefusal(db: Database, request: CommitRequest, launch: { readonly outcome: CommitOutcome; readonly refusal: StoredReceipt | null }): Promise<CommitResult> {
  const refusal = launch.refusal;
  if (refusal === null) return { ok: true, value: launch.outcome };
  const stored = await db.insertInto("authority.ingress_receipt").values({ id: crypto.randomUUID(), run_id: request.run_id, unit_id: null,
    ingress_id: refusal.ingress_id, request_digest: refusal.request_digest, result: jsonText(refusal.result) })
    .onConflict((conflict) => conflict.columns(["run_id", "ingress_id"]).doNothing()).returning("id").executeTakeFirst();
  if (stored) return { ok: true, value: launch.outcome };
  const earlier = await readReceipt(db, request);
  if (!earlier) return { ok: true, value: { kind: "contended", detail: "a concurrent launch's receipt could not be read; retry the launch" } };
  return { ok: true, value: earlier.request_digest === refusal.request_digest ? { kind: "replayed", receipt: earlier.result }
    : { kind: "conflict", detail: "ingress id reused with different content" } };
}

async function commitToRun(trx: DatabaseTransaction, core: CoreClient, request: CommitRequest): Promise<Result<CommitOutcome, CommitFault>> {
  const { run_id } = request;
  const run = await trx.selectFrom("authority.run").select(["id", "definition_id", "config"])
    .where("id", "=", run_id).forUpdate().executeTakeFirst();
  if (!run) return { ok: true, value: { kind: "missing", detail: "run not found" } };
  if (request.launch && run.definition_id !== request.launch.definition_id)
    return { ok: true, value: { kind: "conflict", detail: "run is pinned to a different definition" } };
  const digest = requestDigest(request);
  const receipt = await readReceipt(trx, request);
  if (receipt) return { ok: true, value: receipt.request_digest === digest ? { kind: "replayed", receipt: receipt.result }
    : { kind: "conflict", detail: "ingress id reused with different content" } };
  const unit_id = await affectedUnit(trx, run_id, request.event);
  // The receipt names a unit only once the unit is known to exist: its foreign key would refuse any other.
  const reject = async (reason: string, receipt_unit: string | null): Promise<Result<CommitOutcome, CommitFault>> => {
    await storeReceipt(trx, { request, unit_id: receipt_unit, digest, result: { kind: "rejected", reason } });
    return { ok: true, value: { kind: "rejected", reason } };
  };
  if (!unit_id.ok) return reject(unit_id.reason, null);
  const resolved = await compileDefinition(core, run.definition_id as DefinitionId);
  if (!resolved.ok) return { ok: false, error: fault(run_id, `${resolved.error.operation} ${resolved.error.entity_id}: ${resolved.error.detail}`) };
  const definition = resolved.value;
  const snapshot = await readStepSnapshot(trx, run_id, unit_id.value);
  if (!snapshot) return reject(`unit ${unit_id.value} is not part of run ${run_id}`, null);
  if (request.event.kind === "retry_requested") {
    const event = request.event;
    const latest = snapshot.attempts.findLast((attempt) => attempt.unit === event.unit && attempt.worker === event.worker);
    const intent = latest && await trx.selectFrom("authority.effect_intent").select("payload")
      .where("run_id", "=", run_id).where("action_id", "=", latest.action_id).where("seq", "=", latest.seq).executeTakeFirst();
    const key = intent?.payload.execution_key;
    if (request.execution_reconciliation && request.execution_reconciliation !== key)
      return reject("execution is no longer current for this worker", unit_id.value);
    if (key && request.execution_reconciliation !== key) {
      const record = await trx.selectFrom("authority.keyed_execution").select("state").where("id", "=", key).executeTakeFirst();
      if (record?.state === "reconcile") return reject("execution is awaiting reconciliation", unit_id.value);
    }
  }
  let effectiveRequest = request;
  let assessmentDecision: AssessmentDecisionPlan | null = null;
  if (request.event.kind === "revision_published") {
    const event = request.event;
    const unit = snapshot.units.find((candidate) => candidate.id === event.unit);
    const workflow = definition.checked_program.workflow;
    const schema = unit?.kind.kind === "stage" ? workflow.stages[unit.kind.stage]?.artifacts[event.artifact]?.schema : undefined;
    if (schema) {
      const allowed = new Set<string>();
      const previous = snapshot.revisions.find((revision) => revision.id === event.predecessor && revision.unit === event.unit && revision.artifact === event.artifact);
      if (request.writer.kind === "operator" && previous) collectGeneratedIds(schema, previous.body, workflow.schemas, allowed);
      const enriched = enrichGenerated(schema, event.body, workflow.schemas, allowed);
      if (!enriched.ok) return reject(enriched.error, unit_id.value);
      effectiveRequest = { ...request, event: { ...event, body: enriched.value } };
    }
  }
  if (request.event.kind === "operator_decided") {
    const { event } = request;
    const workflow = definition.checked_program;
    const stage = stageOf(workflow, snapshot, event.unit);
    const review = stage?.reviews?.[event.review];
    const decision = review?.decisions[event.decision];
    const assessment = stage && review && assessmentOf(review, stage);
    const facts = assessment ? await readAssessmentFacts(trx, run_id, event.unit, assessment) : null;
    if (facts?.approval && (decision?.operation && decision.operation !== "plain" || decision?.effect === "request_changes")) {
      return reject("approval is final; it cannot be withdrawn or replaced", unit_id.value);
    }
    if (decision?.operation !== undefined && decision.operation !== "plain") {
      const command = parseAssessmentDecision(request.assessment_decision);
      if (!command) return reject("assessment decisions take dispositions only", unit_id.value);
      if (!facts) return reject("assessment revision not found", unit_id.value);
      const plan = selectAssessmentDecisionPlan({ command, facts, snapshot, workflow, event, writer: request.writer });
      if (!plan.ok) return reject(plan.error.detail, unit_id.value);
      assessmentDecision = plan.value;
      effectiveRequest = { ...request, event: plan.value.event };
    } else if (decision) {
      const raw = objectFields(request.assessment_decision);
      if (raw && !Object.hasOwn(raw, "payload")) return reject("request_id, decision, target and payload are required", unit_id.value);
      const refusal = plainPayloadRefusal(decision, event, workflow.workflow.schemas);
      if (refusal !== null) return reject(refusal, unit_id.value);
    }
  }
  const incoming: Incoming = { event: effectiveRequest.event, writer: request.writer, ingress_id: request.ingress_id };
  const stepped = await stepPinned(core, { run_id, definition, snapshot, incoming });
  if (!stepped.ok) return stepped;
  if (stepped.value.kind === "rejected") return reject(stepped.value.reason, unit_id.value);
  if (stepped.value.kind === "stalled") {
    // The event is refused as any rejection is, and the refusal records where the run stopped (D-V4).
    const reason = `run stalled at ${stepped.value.unit}: ${stepped.value.reason}`;
    const stall: StallRecord = { unit_id: stepped.value.unit, event: request.event, after_event: await readLatestEventId(trx, run_id, unit_id.value),
      refused_at: new Date().toISOString() };
    await storeReceipt(trx, { request, unit_id: unit_id.value, digest, result: { kind: "rejected", reason, stall } });
    await trx.insertInto("authority.operator_event").values({ id: crypto.randomUUID(), run_id, run_key: run_id,
      payload: jsonText({ kind: "invalidate", data: { target: "run", run_id } }) }).execute();
    return { ok: true, value: { kind: "rejected", reason } };
  }
  const existing = await readCommitExisting(trx, { request: effectiveRequest, digest, unit_id: unit_id.value, source: definition.source,
    parsed_workflow: definition.checked_program.workflow,
    prompts: definition.prompts, config: run.config, step: stepped.value.step });
  const planned = selectCommitPlan(snapshot, stepped.value.step, existing);
  if (!planned.ok) return { ok: false, error: fault(run_id, planned.error.detail) };
  let assessmentWrites: AssessmentWrites = {};
  let assessmentReceipt: AssessmentDecisionReceipt | undefined;
  const published = planned.value.delta.created_revisions[0];
  if (published && published.artifact !== BLOCKER_ARTIFACT
    && !planned.value.delta.created_decisions.some(value => value.kind === "validation" && value.target === published.id)) {
    const bindings = await planAssessmentPublication(trx, { run_id, snapshot, workflow: definition.checked_program, revision: published });
    if (!bindings.ok) return reject(bindings.error.detail, unit_id.value);
    assessmentWrites = bindings.value;
  }
  if (assessmentDecision) {
    const decision = planned.value.delta.created_decisions.find(value => value.kind === "review");
    if (!decision) return reject("assessment decision produced no decision", unit_id.value);
    const rounds = assessmentDecision.rounds.map(round => ({ ...round, decision: decision.id }));
    const rejections = assessmentDecision.rejections.map(value => ({ ...value, decision: decision.id }));
    const approval = assessmentDecision.approval && { ...assessmentDecision.approval, decision: decision.id };
    assessmentWrites = { assignments: assessmentDecision.assignments, rounds, rejections, approval };
    assessmentReceipt = { decision_id: decision.id, rejection_ids: rejections.map(value => value.id),
      approval_id: approval?.id ?? null, round_ids: rounds.map(value => value.id) };
  }
  await applyCommitPlan(trx, planned.value);
  await writeAssessmentFacts(trx, run_id, assessmentWrites);
  await attachRoundDeliveries(trx, planned.value);
  const result = { kind: "committed" as const, event_id: planned.value.event_id,
    ...(assessmentReceipt ? { assessment_decision: assessmentReceipt } : {}) };
  await storeReceipt(trx, { request, unit_id: unit_id.value, digest, result });
  return ok(result);
}

type Affected = { readonly ok: true; readonly value: string | null } | { readonly ok: false; readonly reason: string };
/** Launch and cancel address the whole run; worker reports address the unit of their attempt. */
async function affectedUnit(trx: DatabaseTransaction, run_id: string, event: Event): Promise<Affected> {
  switch (event.kind) {
    case "launched": case "cancel_requested": return { ok: true, value: null };
    case "revision_published": case "operator_decided": case "retry_requested": return { ok: true, value: event.unit };
    case "worker_started": case "worker_ended": {
      const attempt = await trx.selectFrom("authority.attempt").select("unit_id")
        .where("run_id", "=", run_id).where("action_id", "=", event.action).orderBy("seq", "desc").executeTakeFirst();
      return attempt ? { ok: true, value: attempt.unit_id } : { ok: false, reason: `action ${event.action} has no attempt` };
    }
  }
}

interface StepInput {
  readonly run_id: string;
  readonly definition: import("../core-client/client").CompiledDefinition;
  readonly snapshot: StepSnapshot;
  readonly incoming: Incoming;
}
type Stepped =
  | { readonly kind: "stepped"; readonly step: StepResult }
  | { readonly kind: "rejected"; readonly reason: string }
  /** The event was refused because advancing the run past it stopped at `unit`. */
  | { readonly kind: "stalled"; readonly unit: string; readonly reason: string };
/** Recompile exact committed inputs once if Rust has evicted the program before stepping. */
async function stepPinned(core: CoreClient, input: StepInput): Promise<Result<Stepped, CommitFault>> {
  const step = (workflow_digest: string) => core.request("step", { workflow_digest, snapshot: input.snapshot, incoming: input.incoming });
  let response = await step(input.definition.checked_program.digest);
  if (!response.ok && response.error.kind === "domain" && response.error.detail.kind === "unknown_bundle") {
    const resolved = await compileDefinition(core, input.definition.definition_id);
    if (!resolved.ok) return { ok: false, error: fault(input.run_id, `${resolved.error.operation} ${resolved.error.entity_id}: ${resolved.error.detail}`) };
    response = await step(resolved.value.checked_program.digest);
  }
  if (!response.ok) {
    if (response.error.kind === "domain" && response.error.detail.kind === "rejected_event")
      return { ok: true, value: { kind: "rejected", reason: response.error.detail.detail } };
    if (response.error.kind === "domain" && response.error.detail.kind === "stalled_event")
      return { ok: true, value: { kind: "stalled", unit: response.error.detail.entity_id, reason: response.error.detail.detail } };
    // An inconsistency the core found advancing a unit names it as the entity.
    const unit_id = response.error.kind === "domain" && response.error.detail.kind === "invalid_snapshot"
      && response.error.detail.entity_id !== "step" ? response.error.detail.entity_id : null;
    return { ok: false, error: fault(input.run_id, `core step failed: ${JSON.stringify(response.error)}`, unit_id) };
  }
  if (response.value.kind !== "stepped") return { ok: false, error: fault(input.run_id, "core returned a non-step output") };
  return { ok: true, value: { kind: "stepped", step: response.value.value } };
}

/**
 * What writeDelta does not write must not change: it writes new rows, unit
 * status, a unit's input when it first resolves, and an attempt's status
 * and session. Anything else step changes would be silently lost, so it
 * is named here and the commit faults instead. Null when nothing is lost.
 */
export function selectDeltaViolation(before: StepSnapshot, after: StepSnapshot): string | null {
  if (after.run.id !== before.run.id) return `run ${before.run.id} changed its id to ${after.run.id}`;
  const units = new Map(after.units.map((unit) => [unit.id, unit]));
  for (const old of before.units) {
    const unit = units.get(old.id);
    if (!unit) return `unit ${old.id} was removed`;
    const { status: _old_status, input: old_input, input_provenance: old_provenance, ...old_fixed } = old;
    const { status: _status, input, input_provenance: provenance, ...fixed } = unit;
    if (canonical(old_fixed) !== canonical(fixed)) return `unit ${old.id} changed its declaration, parent, stage, pool or dependencies`;
    if (old_input != null && canonical(old_provenance ?? null) !== canonical(provenance ?? null)) return `unit ${old.id} changed frozen input provenance`;
    if (old_input !== null && canonical(old_input) !== canonical(input)) return `unit ${old.id} changed an input it had already resolved`;
  }
  const attempts = new Map(after.attempts.map((attempt) => [`${attempt.action_id}#${attempt.seq}`, attempt]));
  for (const old of before.attempts) {
    const attempt = attempts.get(`${old.action_id}#${old.seq}`);
    if (!attempt) return `attempt ${old.action_id}#${old.seq} was removed`;
    if (attempt.unit !== old.unit || attempt.worker !== old.worker || canonical(attempt.mode) !== canonical(old.mode)
      || canonical(attempt.cause) !== canonical(old.cause)) return `attempt ${old.action_id}#${old.seq} changed its unit, worker, mode or cause`;
  }
  const revisions = new Map(after.revisions.map((revision) => [revision.id, revision]));
  for (const old of before.revisions)
    if (canonical(revisions.get(old.id) ?? null) !== canonical(old)) return `revision ${old.id} was changed or removed`;
  const decisions = new Map(after.decisions.map((decision) => [decision.id, decision]));
  for (const old of before.decisions)
    if (canonical(decisions.get(old.id) ?? null) !== canonical(old)) return `decision ${old.id} was changed or removed`;
  return null;
}

interface DeltaPlan {
  readonly run: StepSnapshot["run"];
  readonly created_units: StepSnapshot["units"];
  readonly changed_units: StepSnapshot["units"];
  readonly created_attempts: StepSnapshot["attempts"];
  readonly changed_attempts: StepSnapshot["attempts"];
  readonly created_revisions: StepSnapshot["revisions"];
  readonly created_decisions: StepSnapshot["decisions"];
}
/** Pure state delta; the applier receives only rows and updates it must write. */
function selectDeltaPlan(before: StepSnapshot, after: StepSnapshot): DeltaPlan {
  const known = new Map(before.units.map((unit) => [unit.id, unit]));
  // Parents first: a member's foreign key names its parent.
  const created_units = after.units.filter((unit) => !known.has(unit.id)).sort((left, right) => left.id.split("/").length - right.id.split("/").length);
  const changed_units = after.units.filter((unit) => {
    const old = known.get(unit.id);
    return old && (canonical(old.status) !== canonical(unit.status) || canonical(old.input) !== canonical(unit.input));
  });
  const old_attempts = new Map(before.attempts.map((attempt) => [`${attempt.action_id}#${attempt.seq}`, attempt]));
  const created_attempts = after.attempts.filter((attempt) => !old_attempts.has(`${attempt.action_id}#${attempt.seq}`));
  const changed_attempts = after.attempts.filter((attempt) => {
    const old = old_attempts.get(`${attempt.action_id}#${attempt.seq}`);
    return old && canonical(old) !== canonical(attempt);
  });
  const old_revisions = new Set(before.revisions.map((revision) => revision.id));
  const old_decisions = new Set(before.decisions.map((decision) => decision.id));
  return { run: after.run, created_units, changed_units, created_attempts, changed_attempts,
    created_revisions: after.revisions.filter((revision) => !old_revisions.has(revision.id)),
    created_decisions: after.decisions.filter((decision) => !old_decisions.has(decision.id)) };
}

/** Apply only planned delta writes. */
async function writeDelta(trx: DatabaseTransaction, run_id: string, plan: DeltaPlan): Promise<void> {
  const root = plan.created_units.find((unit) => unit.id === plan.run.root);
  await trx.updateTable("authority.run").set({ root_unit_id: plan.run.root,
    ...(root ? { input: root.input === null ? null : jsonText(root.input) } : {}) }).where("id", "=", run_id).execute();
  for (const unit of plan.created_units) await trx.insertInto("authority.unit").values({ id: unit.id, run_id, parent_id: unit.parent ?? null,
    declaration: unit.declaration, stage: unit.kind.kind === "stage" ? unit.kind.stage : null,
    collection_key: unit.collection_key ?? null, pool: unit.pool ?? null,
    input_provenance: unit.input_provenance == null ? null : jsonText(unit.input_provenance),
    input: unit.input === null ? null : jsonText(unit.input), status: jsonText(unit.status) }).execute();
  for (const unit of plan.created_units) for (const depends_on_id of unit.after)
    await trx.insertInto("authority.unit_dependency").values({ run_id, unit_id: unit.id, depends_on_id }).execute();
  for (const unit of plan.changed_units) await trx.updateTable("authority.unit").set({ status: jsonText(unit.status),
    input_provenance: unit.input_provenance == null ? null : jsonText(unit.input_provenance),
    input: unit.input === null ? null : jsonText(unit.input) })
    .where("run_id", "=", run_id).where("id", "=", unit.id).execute();
  for (const attempt of plan.created_attempts) await trx.insertInto("authority.attempt").values({ action_id: attempt.action_id, seq: attempt.seq, run_id,
      unit_id: attempt.unit, worker: attempt.worker, mode: jsonText(attempt.mode), cause: jsonText(attempt.cause),
      status: jsonText(attempt.status), kbbl_session_id: attempt.kbbl_session_id ?? null }).execute();
  for (const attempt of plan.changed_attempts) await trx.updateTable("authority.attempt")
      .set({ status: jsonText(attempt.status), kbbl_session_id: attempt.kbbl_session_id ?? null })
      .where("action_id", "=", attempt.action_id).where("seq", "=", attempt.seq).execute();
  for (const revision of plan.created_revisions)
    await trx.insertInto("authority.artifact_revision").values({ id: revision.id, run_id, unit_id: revision.unit, artifact: revision.artifact, seq: revision.seq,
      decision_cursor: revision.decision_cursor ?? 0,
      body: jsonText(revision.body), by_id: revision.by, predecessor_id: revision.predecessor ?? null, subject: revision.subject ?? null }).execute();
  for (const decision of plan.created_decisions) {
    const is_validation = decision.kind === "validation";
    const effect = is_validation ? "request_changes" : decision.effect.kind;
    const payload = is_validation ? { feedback: decision.messages.join("; ") } : decision.payload;
    await trx.insertInto("authority.review_decision").values({ id: decision.id, run_id, unit_id: decision.unit,
      review: is_validation ? VALIDATION_REVIEW : decision.review,
      decision: is_validation ? "request_changes" : decision.decision, effect,
      target_revision_id: decision.target, payload: jsonText(payload),
      validation_artifact: is_validation ? decision.artifact : null,
      validation_messages: is_validation ? decision.messages : null }).execute();
  }
}

interface CommitReadInput {
  readonly request: CommitRequest;
  readonly digest: string;
  readonly unit_id: string | null;
  readonly source: import("../core-client/source-types").WorkflowDefinitionDescriptor;
  readonly parsed_workflow: ParsedWorkflow;
  readonly prompts: { readonly [path: string]: string };
  readonly config: RunConfig | null;
  readonly step: StepResult;
}
/** Everything planning needs from storage, read under the run lock before any writes. */
export interface CommitExisting extends Omit<CommitReadInput, "step"> {
  readonly intent_actions: readonly string[];
  readonly review_rows: readonly { readonly id: string; readonly review_prompts: ReviewPrompts; readonly blocked_reason: BlockedReason | null }[];
  readonly prompt_texts: ReadonlyMap<string, string>;
  readonly logged_wanted: ReadonlyMap<string, WantedWorkers>;
  readonly event_id: string;
}
interface ReviewPromptLocation { readonly workflow: ParsedWorkflow; readonly stage: string | null; readonly review: string }
function reviewPromptPath(location: ReviewPromptLocation): string | null {
  return location.stage === null ? null : location.workflow.stages[location.stage]?.reviews?.[location.review]?.prompt ?? null;
}
async function readCommitExisting(trx: DatabaseTransaction, input: CommitReadInput): Promise<CommitExisting> {
  const { request, step, source, prompts } = input;
  const unit_ids = step.snapshot.units.map((unit) => unit.id);
  const wanted = selectWanted(step);
  const [intent_rows, review_rows, logged_rows] = await Promise.all([
    unit_ids.length ? trx.selectFrom("authority.effect_intent").select("action_id").where("run_id", "=", request.run_id)
      .where("unit_id", "=", anyOf(unit_ids)).execute() : Promise.resolve([]),
    unit_ids.length ? trx.selectFrom("authority.unit").select(["id", "review_prompts", "blocked_reason"]).where("run_id", "=", request.run_id)
      .where("id", "=", anyOf(unit_ids)).execute() : Promise.resolve([]),
    wanted.length ? trx.selectFrom("authority.wanted_log as wanted").innerJoin("authority.event as event", (join) =>
      join.onRef("event.run_id", "=", "wanted.run_id").onRef("event.id", "=", "wanted.event_id"))
      .distinctOn("wanted.unit_id").select(["wanted.unit_id", "wanted.actions"]).where("wanted.run_id", "=", request.run_id)
      .where("wanted.unit_id", "=", anyOf(wanted.map((item) => item.unit_id)))
      .orderBy("wanted.unit_id").orderBy("event.created_at", "desc").orderBy("event.id", "desc").execute() : Promise.resolve([]),
  ]);
  return { request, digest: input.digest, unit_id: input.unit_id, source,
    parsed_workflow: input.parsed_workflow, prompts, config: input.config,
    intent_actions: intent_rows.map((row) => row.action_id), review_rows, prompt_texts: new Map(Object.entries(prompts)),
    logged_wanted: new Map(logged_rows.map((row) => [row.unit_id, row.actions])), event_id: crypto.randomUUID() };
}

interface PlannedIntent { readonly unit_id: string; readonly action_id: ActionId; readonly seq: number;
  readonly instruction: ReviewHistoryInstruction; readonly authorizing_revision?: string }
interface ReviewUpdate { readonly unit_id: string; readonly prompts: ReviewPrompts }
interface BlockedUpdate { readonly unit_id: string; readonly reason: BlockedReason | null }
export interface CommitPlan {
  readonly run_id: RunId;
  readonly request: CommitRequest;
  readonly unit_id: string | null;
  readonly event_id: string;
  readonly delta: DeltaPlan;
  readonly publication_secret: { readonly action_id: ActionId; readonly seq: number; readonly hash: string } | null;
  readonly intents: readonly PlannedIntent[];
  readonly replaced_actions: readonly ActionId[];
  readonly inactive_units: readonly string[];
  readonly review_updates: readonly ReviewUpdate[];
  readonly blocked_updates: readonly BlockedUpdate[];
  readonly changed_wanted: readonly WantedForUnit[];
  readonly run_event_fields: RunEventFields;
}

/** All validation and write decisions are made from values, with no database handle. */
export function selectCommitPlan(before: StepSnapshot, step: StepResult, existing: CommitExisting): Result<CommitPlan, CommitViolation> {
  const { request, source, prompts, config, event_id } = existing;
  const { run_id } = request;
  if (request.publication_secret_hash && request.event.kind !== "worker_started")
    return violation(run_id, `a publication secret hash rides only on worker_started, not ${request.event.kind}`);
  const delta_violation = selectDeltaViolation(before, step.snapshot);
  if (delta_violation !== null) return violation(run_id, `step changed state commit does not write: ${delta_violation}`);
  let publication_secret: CommitPlan["publication_secret"] = null;
  if (request.event.kind === "worker_started" && request.publication_secret_hash) {
    const action_id = request.event.action;
    const started = step.snapshot.attempts.filter((attempt) => attempt.action_id === action_id)
      .reduce<StepSnapshot["attempts"][number] | null>((latest, attempt) => latest && latest.seq > attempt.seq ? latest : attempt, null);
    if (!started) return violation(run_id, `started action ${request.event.action} has no attempt`);
    publication_secret = { action_id: started.action_id as ActionId, seq: started.seq, hash: request.publication_secret_hash };
  }
  const known = new Set(existing.intent_actions);
  const intents: PlannedIntent[] = [];
  const replaced_actions: ActionId[] = [];
  for (const worker of step.wanted) {
    const { action_id, attempt_seq, action, resolved } = worker;
    if (known.has(action_id)) continue;
    const unit = step.snapshot.units.find((candidate) => candidate.id === worker.unit);
    if (unit?.kind.kind !== "stage") return violation(run_id, `wanted worker ${worker.unit}/${worker.worker} is not on a stage`);
    const instruction = selectEffectInstruction({ run_id, workflow: source, parsed_workflow: existing.parsed_workflow,
      prompts: Object.fromEntries(Object.entries(prompts).map(([path, text]) => [path, createHash("sha256").update(text).digest("hex")])), stage: unit.kind.stage, config,
      action, seq: attempt_seq, resolved });
    if (!instruction.ok) return violation(run_id, instruction.error.detail);
    intents.push({ unit_id: worker.unit, action_id: action_id as ActionId, seq: attempt_seq, instruction: withReviewHistory(instruction.value, resolved), authorizing_revision: resolved.keyed_execution?.authorizing_revision });
    known.add(action_id);
    const replaced = selectReplacedAction(action);
    if (replaced !== null) replaced_actions.push(replaced);
  }
  const rendered = new Map<string, { [review: string]: ReviewPrompt }>();
  for (const review of step.reviews) {
    const kind = step.snapshot.units.find((unit) => unit.id === review.unit)?.kind;
    const stage = kind?.kind === "stage" ? kind.stage : null;
    const path = reviewPromptPath({ workflow: existing.parsed_workflow, stage, review: review.review });
    const text = review.review === BLOCKER_REVIEW ? BLOCKER_REVIEW_PROMPT
      : path === null ? undefined : existing.prompt_texts.get(path);
    if (text === undefined) return violation(run_id, `review ${review.review} on ${review.unit} has no pinned prompt text`);
    const inputs = typeof review.inputs === "object" && review.inputs !== null ? review.inputs as { readonly [key: string]: unknown } : {};
    const unit = rendered.get(review.unit) ?? {};
    unit[review.review] = { target: review.target, decisions: review.decisions, prompt: renderTemplate(text, inputs) };
    rendered.set(review.unit, unit);
  }
  const review_updates: ReviewUpdate[] = [];
  const old_blocked = new Map(existing.review_rows.map((row) => [row.id, row.blocked_reason]));
  const emitted_blocked = new Map(step.blocked.map(({ unit, reason }) => [unit, reason]));
  const blocked_updates: BlockedUpdate[] = step.snapshot.units.flatMap((unit) => {
    const reason = emitted_blocked.get(unit.id) ?? null;
    return canonical(old_blocked.get(unit.id) ?? null) === canonical(reason) ? [] : [{ unit_id: unit.id, reason }];
  });
  const newly_awaiting = new Map<string, readonly string[]>();
  for (const row of existing.review_rows) {
    const next: ReviewPrompts = rendered.get(row.id) ?? {};
    if (canonical(next) === canonical(row.review_prompts)) continue;
    review_updates.push({ unit_id: row.id, prompts: next });
    const began = Object.keys(next).filter((review) => row.review_prompts[review]?.target !== next[review]?.target).sort();
    if (began.length > 0) newly_awaiting.set(row.id, began);
  }
  const addressed = step.snapshot.units.find((unit) => unit.id === (existing.unit_id ?? step.snapshot.run.root));
  if (!addressed) return violation(run_id, `event ${event_id} addresses no unit of the run`);
  const run_event_fields = selectRunEventFields({ event_id, run_id, kind: request.event.kind,
    run_status: step.snapshot.units.find((unit) => unit.id === step.snapshot.run.root)?.status ?? { kind: "not_started" },
    tree: selectUnitTree(step.snapshot.units.map((unit) => ({ id: unit.id, parent_id: unit.parent ?? null, declaration: unit.declaration })), source),
    unit: { id: addressed.id as UnitId, parent_id: addressed.parent ?? null, declaration: addressed.declaration,
      stage: addressed.kind.kind === "stage" ? addressed.kind.stage : null, collection_key: addressed.collection_key ?? null,
      status: addressed.status }, newly_awaiting: newly_awaiting.get(addressed.id) ?? [] });
  return { ok: true, value: { run_id, request, unit_id: existing.unit_id, event_id,
    delta: selectDeltaPlan(before, step.snapshot), publication_secret, intents, replaced_actions,
    inactive_units: step.snapshot.units.filter((unit) => isTerminalStatus(unit.status)).map((unit) => unit.id),
    review_updates, blocked_updates, changed_wanted: selectChangedWanted(selectWanted(step), existing.logged_wanted), run_event_fields } };
}

/** A shared agent session outlives each member until all direct siblings end. */
function isSharedSessionGroupReady(group: string, units: readonly { readonly id: string; readonly status: UnitStatus }[]): boolean {
  const members = units.filter((unit) => unit.id.startsWith(`${group}/`) && !unit.id.slice(group.length + 1).includes("/"));
  return members.length > 0 && members.every((unit) => isTerminalStatus(unit.status));
}

/** Write the selected plan and reconcile effect stops with persisted session ownership. */
export async function applyCommitPlan(trx: DatabaseTransaction, plan: CommitPlan): Promise<void> {
  const { run_id } = plan;
  await writeDelta(trx, run_id, plan.delta);
  if (plan.publication_secret) await trx.updateTable("authority.attempt").set({ publication_secret_hash: plan.publication_secret.hash })
    .where("run_id", "=", run_id).where("action_id", "=", plan.publication_secret.action_id)
    .where("seq", "=", plan.publication_secret.seq).execute();
  const event = await trx.insertInto("authority.event").values({ id: plan.event_id, run_id, unit_id: plan.unit_id,
    ingress_id: plan.request.ingress_id, payload: jsonText(plan.request.event), writer: jsonText(plan.request.writer) })
    .returning("created_at").executeTakeFirstOrThrow();
  for (const intent of plan.intents) {
    const execution_key = intent.authorizing_revision === undefined ? undefined : await ensureKeyedExecution(trx, {
      run_id, unit_id: intent.unit_id, worker: intent.instruction.action.worker, authorizing_revision_id: intent.authorizing_revision,
    });
    const instruction = execution_key ? { ...intent.instruction, execution_key } : intent.instruction;
    await trx.insertInto("authority.effect_intent").values({ id: crypto.randomUUID(), run_id,
      unit_id: intent.unit_id, action_id: intent.action_id, seq: intent.seq, payload: jsonText(instruction) }).execute();
  }
  for (const action_id of plan.replaced_actions) await trx.updateTable("authority.effect_intent")
    .set({ status: "stop_requested", stop_origin: "commit", updated_at: new Date() })
    .where("run_id", "=", run_id).where("action_id", "=", action_id).where("status", "in", START_OWED_STATUSES).execute();
  if (plan.inactive_units.length) {
    const units = await trx.selectFrom("authority.unit").select(["id", "status"]).where("run_id", "=", run_id).execute();
    const owed = await trx.selectFrom("authority.effect_intent").select(["id", "payload"])
      .where("run_id", "=", run_id).where("unit_id", "=", anyOf(plan.inactive_units))
      .where("status", "in", START_OWED_STATUSES).execute();
    const stop_ids = owed.filter(({ payload }) => payload.worker.kind !== "agent" || payload.worker.session !== "shared"
      || (payload.worker.shared_session_unit !== undefined && isSharedSessionGroupReady(payload.worker.shared_session_unit, units)))
      .map(({ id }) => id);
    if (stop_ids.length) await trx.updateTable("authority.effect_intent")
      .set({ status: "stop_requested", stop_origin: "commit", updated_at: new Date() })
      .where("id", "=", anyOf(stop_ids)).execute();
    // A successful turn settles its intent while its resumable kbbl session
    // stays open for review changes. Once the unit is terminal, that session
    // must be closed too. Reopen only intents with a recorded session and no
    // previous stop; the cleanup carrier retries until kbbl acknowledges it.
    const finished_sessions = await trx.selectFrom("authority.effect_intent as intent")
      .innerJoin("authority.attempt as attempt", (join) => join
        .onRef("attempt.run_id", "=", "intent.run_id")
        .onRef("attempt.action_id", "=", "intent.action_id")
        .onRef("attempt.seq", "=", "intent.seq"))
      .select(["intent.id", "intent.payload"])
      .where("intent.run_id", "=", run_id)
      .where("intent.unit_id", "=", anyOf(plan.inactive_units))
      .where("intent.status", "=", "stopped")
      .where("intent.stop_origin", "is", null)
      .where("attempt.kbbl_session_id", "is not", null)
      .execute();
    const cleanup_ids = finished_sessions.filter(({ payload }) => payload.worker.kind !== "agent" || payload.worker.session !== "shared"
      || (payload.worker.shared_session_unit !== undefined && isSharedSessionGroupReady(payload.worker.shared_session_unit, units)))
      .map(({ id }) => id);
    if (cleanup_ids.length) await trx.updateTable("authority.effect_intent")
      .set({ status: "stop_requested", stop_origin: "commit", updated_at: new Date() })
      .where("id", "=", anyOf(cleanup_ids)).execute();
  }
  for (const update of plan.review_updates) await trx.updateTable("authority.unit").set({ review_prompts: jsonText(update.prompts) })
    .where("run_id", "=", run_id).where("id", "=", update.unit_id).execute();
  for (const update of plan.blocked_updates) await trx.updateTable("authority.unit")
    .set({ blocked_reason: update.reason === null ? null : jsonText(update.reason) })
    .where("run_id", "=", run_id).where("id", "=", update.unit_id).execute();
  if (plan.changed_wanted.length) await trx.insertInto("authority.wanted_log").values(plan.changed_wanted.map(({ unit_id, actions }) =>
    ({ id: crypto.randomUUID(), run_id, unit_id, event_id: plan.event_id, actions: jsonText(actions) }))).execute();
  const run_event: RunEvent = { ...plan.run_event_fields, occurred_at: event.created_at.toISOString() };
  await trx.insertInto("authority.operator_event").values({ id: crypto.randomUUID(), run_id, run_key: run_id,
    payload: jsonText({ kind: "run_event", data: run_event }) }).execute();
}

/** The action a periodic worker's new watch replaces; null for any other action, or a first watch. */
export function selectReplacedAction(action: RunWorkerAction): ActionId | null {
  return action.cause.kind === "periodic" && action.cause.replaces ? action.cause.replaces as ActionId : null;
}

/** The units whose wanted set differs from the one last logged for them; a unit never logged has changed. */
export function selectChangedWanted(wanted: readonly WantedForUnit[], logged: ReadonlyMap<string, WantedWorkers>): readonly WantedForUnit[] {
  return wanted.filter(({ unit_id, actions }) => {
    const prior = logged.get(unit_id);
    return prior === undefined || canonical(prior) !== canonical(actions);
  });
}

interface ReceiptInput { readonly request: Pick<CommitRequest, "run_id" | "ingress_id">; readonly unit_id: string | null; readonly digest: string; readonly result: CommitReceipt }
/**
 * Under the run row lock no other receipt can race this one. A launch that
 * created its run row holds no lock a refused launch's receipt waits on, and
 * may meet one stored meanwhile: it keeps that receipt, and answers from it
 * once its own transaction has rolled back.
 */
async function storeReceipt(trx: DatabaseTransaction, input: ReceiptInput): Promise<void> {
  if (input.request.ingress_id === null) return;
  await trx.insertInto("authority.ingress_receipt").values({ id: crypto.randomUUID(), run_id: input.request.run_id, unit_id: input.unit_id,
    ingress_id: input.request.ingress_id, request_digest: input.digest, result: jsonText(input.result) })
    .onConflict((conflict) => conflict.columns(["run_id", "ingress_id"]).doNothing()).execute();
}

/** A declaration as ingress hands it over: the writer is resolved from the credential, never the body. */
export interface DeclarationRequest {
  readonly declaration: AnalysisLinkDeclaration;
  readonly ingress_id: string;
  readonly writer: Writer;
}

/**
 * Journals an explicit analysis-link declaration on the ordered event table, after checking its
 * exact addresses against this run's authority. It takes the run row lock, so it orders with the
 * run's other events and answers a replayed ingress id from its receipt, but it never steps the
 * core: it starts no worker, changes no unit and is no decision. A refusal is stored like a rejected
 * event, so a replay returns it again. Delivery to observation happens later, from the journal, so
 * an outage there cannot touch the approval or the run.
 */
export async function commitAnalysisLinkDeclaration(db: Database, request: DeclarationRequest): Promise<CommitResult> {
  const { run_id } = request.declaration;
  const scoped_ingress_id = scopeIngressId(request.writer, request.ingress_id);
  try {
    return { ok: true, value: await db.transaction().execute((trx) => journalAnalysisLinkDeclaration(trx, { ...request, scoped_ingress_id })) };
  } catch (error) {
    const conflict = concurrencyConflict(error);
    if (conflict) return { ok: true, value: { kind: "contended", detail: conflict } };
    return { ok: false, error: { operation: "commit_analysis_link_declaration", entity_id: run_id, detail: String(error) } };
  }
}

/** The writer's work inside a caller's transaction, so a tasks approval and what it supplies commit together. */
async function journalAnalysisLinkDeclaration(trx: DatabaseTransaction, request: Omit<DeclarationRequest, "ingress_id"> & { readonly scoped_ingress_id: IngressId | null }): Promise<CommitOutcome> {
  const { declaration, writer } = request;
  const { run_id } = declaration;
  const scoped = { run_id: run_id as RunId, ingress_id: request.scoped_ingress_id };
  const event: AnalysisLinksDeclared = { kind: ANALYSIS_LINKS_DECLARED, ...declaration };
  const digest = requestDigest({ event, writer });
  const run = await trx.selectFrom("authority.run").select("id").where("id", "=", run_id).where("root_unit_id", "is not", null).forUpdate().executeTakeFirst();
  if (!run) return { kind: "missing", detail: "run not found" };
  const receipt = await readReceipt(trx, scoped);
  if (receipt) return receipt.request_digest === digest ? { kind: "replayed", receipt: receipt.result }
    : { kind: "conflict", detail: "ingress id reused with different content" };
  const revision_ids = [declaration.tasks_revision_id, ...declaration.entries.map((entry) => entry.source_revision_id)];
  const revisions = await trx.selectFrom("authority.artifact_revision").select(["id", "artifact", "body"]).where("run_id", "=", run_id)
    .where("id", "=", anyOf(revision_ids)).execute();
  const approval = await trx.selectFrom("authority.review_decision").select("id").where("run_id", "=", run_id)
    .where("target_revision_id", "=", declaration.tasks_revision_id).where("effect", "=", "approve").limit(1).executeTakeFirst();
  const refusal = selectDeclarationRefusal(declaration, { tasks_revision: revisions.find((revision) => revision.id === declaration.tasks_revision_id) ?? null,
    is_tasks_revision_approved: approval !== undefined, sources: new Map(revisions.map((revision) => [revision.id, revision])) });
  if (refusal !== null) {
    await storeReceipt(trx, { request: scoped, unit_id: null, digest, result: { kind: "rejected", reason: refusal } });
    return { kind: "rejected", reason: refusal };
  }
  const event_id = crypto.randomUUID();
  await trx.insertInto("authority.event").values({ id: event_id, run_id, unit_id: null, ingress_id: scoped.ingress_id,
    payload: jsonText(event), writer: jsonText(writer) }).execute();
  await storeReceipt(trx, { request: scoped, unit_id: null, digest, result: { kind: "committed", event_id } });
  return { kind: "committed", event_id };
}

/** What a decision's own supplied links came to. The decision stands whichever it is. */
export interface DecisionWithLinks { readonly decision: CommitResult; readonly links: CommitOutcome | null }
const decisionStands = (outcome: CommitOutcome): boolean => outcome.kind === "committed" || (outcome.kind === "replayed" && outcome.receipt.kind === "committed");

/**
 * The approved-tasks caller. An approval naming entries journals them against the revision it decides,
 * in its own transaction, so no crash can leave the approval without what came with it. A refused
 * entry refuses only the declaration: links never decide an approval. A replay answers from both
 * receipts, so a retried request can neither repeat the links nor lose them.
 */
export async function commitDecisionWithLinks(deps: CommitDependencies, request: CommitRequest & { readonly event: Extract<Event, { readonly kind: "operator_decided" }> }, entries: readonly AnalysisLinkEntry[]): Promise<DecisionWithLinks> {
  let links: CommitOutcome | null = null;
  const decision = await commitEvent(deps, request, async (trx, outcome) => {
    if (!decisionStands(outcome)) return;
    // Outside every writer's namespace, so no id a caller may choose can land on this receipt.
    const scoped_ingress_id = `decision-links:${scopeIngressId(request.writer, request.ingress_id)}` as IngressId;
    links = await journalAnalysisLinkDeclaration(trx, { scoped_ingress_id, writer: request.writer,
      declaration: { run_id: request.run_id, tasks_revision_id: request.event.target, entries } });
  });
  return { decision, links };
}

/**
 * The one run id derivation (D8): a launch's request id names its run, so a
 * replayed launch finds its receipt. Sixteen hex characters (64 bits) of the
 * digest: every id in a run is prefixed by its run id, and 64 bits keep two
 * launches from colliding.
 */
export function launchRunId(request_id: string): RunId {
  return `run-${createHash("sha256").update(request_id).digest("hex").slice(0, 16)}` as RunId;
}

interface AssessmentPublicationInput {
  readonly run_id: string;
  readonly snapshot: StepSnapshot;
  readonly workflow: CompiledWorkflow;
  readonly revision: RevisionState;
}

async function planAssessmentPublication(trx: DatabaseTransaction, input: AssessmentPublicationInput): Promise<Result<AssessmentWrites, AssessmentFactError>> {
  const { run_id, snapshot, workflow, revision } = input;
  const unit = snapshot.units.find(value => value.id === revision.unit);
  if (unit?.kind.kind !== "stage") return ok({});
  const stage = workflow.workflow.stages[unit.kind.stage];
  const embeddings = workflow.assessments[unit.kind.stage]?.[revision.artifact];
  const attempt = snapshot.attempts.findLast(value => value.action_id === revision.by);
  const producer = attempt && stage?.workers?.[attempt.worker];
  const subjectBinding = attempt && selectSelfAssessmentSubjects(stage, attempt.worker)
    .find(binding => binding.assessment === revision.artifact);
  if (subjectBinding) {
    const subject = latestRevision(snapshot, revision.unit, subjectBinding.subject_artifact);
    if (!subject || subject.id !== revision.subject) {
      return traced("publish_assessment", revision.id, `assessment must cite the exact latest ${subjectBinding.subject_artifact} revision as subject`);
    }
  }
  let update: AssignmentUpdate | null = null;
  let selfUpdate: AssignmentUpdate | null = null;
  if (attempt?.cause.kind === "assignment_round") {
    const roundId = attempt.cause.round;
    const location = await readRoundAssessment(trx, run_id, roundId);
    if (location) {
      const facts = await readAssessmentFacts(trx, run_id, location.unit_id, location.assessment_artifact);
      const round = facts?.rounds.find(value => value.id === roundId);
      const isSelfAssessing = producer?.kind === "agent" && producer.produces.includes(location.assessment_artifact);
      if (facts && round && selectCurrentRound(facts, round.assignment)?.id === round.id && !facts.updates.some(value => value.round === round.id)) {
        if (isSelfAssessing && revision.artifact === location.assessment_artifact) selfUpdate = { round: round.id, revision: revision.id };
        if (!isSelfAssessing) update = { round: round.id, revision: revision.id };
      }
    }
  }
  if (!embeddings) return ok(update ? { updates: [update] } : {});
  const facts = await readAssessmentFacts(trx, run_id, revision.unit, revision.artifact);
  const plan = selectPublicationFacts({ run: run_id, revision, revisions: snapshot.revisions, embeddings, facts, roundUpdate: selfUpdate });
  if (!plan.ok || !update) return plan;
  return ok({ ...plan.value, updates: [...(plan.value.updates ?? []), update] });
}

function renderReassessment(facts: AssessmentFacts): string[] {
  return facts.assignments.flatMap(assignment => {
    const round = selectCurrentRound(facts, assignment.id);
    const update = round && facts.updates.find(value => value.round === round.id);
    if (!round || !update || selectRoundProgress(facts, round) !== "awaiting_verification") return [];
    return [`Round ${round.id}\nRecipient: ${assignment.recipient}\nInstruction: ${round.instruction}\nUpdate revision: ${update.revision}`];
  });
}

async function attachRoundDeliveries(trx: DatabaseTransaction, plan: CommitPlan): Promise<void> {
  for (const intent of plan.intents) {
    const { instruction } = intent;
    const cause = instruction.action.cause;
    let round_delivery: string;
    if (cause.kind === "assignment_round" || cause.kind === "reassessment") {
      const delivery = await readRoundDelivery(trx, { run_id: plan.run_id, round: cause.round });
      if (!delivery) throw new Error(`missing committed facts for ${cause.round}`);
      if (cause.kind === "assignment_round") {
        await bindRoundAction(trx, { run_id: plan.run_id, round: cause.round, action: intent.action_id });
        round_delivery = renderRoundDelivery(delivery.round, delivery.item);
      } else {
        round_delivery = renderReassessment(delivery.facts).join("\n\n");
      }
    } else if (cause.kind === "review_of" && instruction.worker.kind === "agent") {
      // A new work revision can independently want the same assessment worker.
      const facts = await Promise.all(instruction.worker.creates.filter(value => value.key !== BLOCKER_ARTIFACT)
        .map(value => readAssessmentFacts(trx, plan.run_id, intent.unit_id, value.key)));
      round_delivery = facts.flatMap(value => value ? renderReassessment(value) : []).join("\n\n");
    } else continue;
    if (!round_delivery) continue;
    await trx.updateTable("authority.effect_intent").set({ payload: jsonText({ ...instruction, engine_inputs: { ...instruction.engine_inputs, round_delivery } }) })
      .where("run_id", "=", plan.run_id).where("action_id", "=", intent.action_id).where("seq", "=", intent.seq).execute();
  }
}

type AssessmentMutation = { readonly kind: "feedback"; readonly artifact: string; readonly command: FeedbackItemRequest }
  | { readonly kind: "authorization"; readonly command: DispatchAuthorizationRequest };

export interface AssessmentMutationInput {
  readonly run_id: RunId;
  readonly unit: string;
  readonly request_id: string;
  readonly writer: Extract<Writer, { readonly kind: "operator" }>;
  readonly mutation: AssessmentMutation;
}

export async function commitAssessmentMutation(deps: CommitDependencies, input: AssessmentMutationInput): Promise<CommitResult> {
  const { run_id, unit, writer, mutation } = input;
  const request = { run_id, ingress_id: scopeIngressId(writer, input.request_id) };
  const digest = createHash("sha256").update(canonical({ unit, writer, mutation })).digest("hex");
  try {
    return await deps.db.transaction().execute(async trx => {
      const run = await trx.selectFrom("authority.run").select("definition_id").where("id", "=", run_id).forUpdate().executeTakeFirst();
      if (!run) return ok({ kind: "missing", detail: "run not found" });
      const receipt = await readReceipt(trx, request);
      if (receipt) return ok(receipt.request_digest === digest ? { kind: "replayed", receipt: receipt.result }
        : { kind: "conflict", detail: "ingress id reused with different content" });
      const snapshot = await readStepSnapshot(trx, run_id, unit);
      if (!snapshot) return ok({ kind: "missing", detail: "unit not found" });
      const reject = async (reason: string): Promise<CommitResult> => {
        const result = { kind: "rejected" as const, reason };
        await storeReceipt(trx, { request, unit_id: unit, digest, result });
        return ok(result);
      };
      const definition = await compileDefinition(deps.core, run.definition_id as DefinitionId);
      if (!definition.ok) return definition;
      const stage = stageOf(definition.value.checked_program, snapshot, unit);
      if (!stage) return reject("unit has no assessment");
      let writes: AssessmentWrites;
      let id: string;
      if (mutation.kind === "feedback") {
        const { command, artifact } = mutation;
        if (stage.artifacts?.[artifact]?.kind !== "assessment") return reject("assessment artifact not found");
        const facts = await readAssessmentFacts(trx, run_id, unit, artifact);
        if (!facts) return reject("assessment revision not found");
        if (facts.approval) return reject("approval is final; it cannot be withdrawn or replaced");
        if (command.citation != null) {
          const citation = resolveCitation(command.citation, snapshot.revisions);
          if (!citation.ok) return reject(citation.error.detail);
        }
        id = assessmentFactId("fi_", [run_id, request.ingress_id!]);
        writes = { items: [{ id, unit, assessment_artifact: artifact, origin: { kind: "operator", request_id: request.ingress_id! },
          instruction: command.instruction, citation: command.citation }],
          associations: [{ assessment_revision: facts.revision, item: id, association: "proposed" }] };
      } else {
        const { command } = mutation;
        const target = snapshot.revisions.find(value => value.id === command.target_revision && value.unit === unit);
        if (!target || latestRevision(snapshot, unit, target.artifact)?.id !== target.id) return reject("dispatch target is not the latest revision");
        let selected: { readonly facts: AssessmentFacts; readonly item: FeedbackItem; readonly operation: DispatchOperation } | null = null;
        for (const review of Object.values(stage.reviews ?? {})) {
          const artifact = assessmentOf(review, stage);
          if (!artifact) continue;
          const facts = await readAssessmentFacts(trx, run_id, unit, artifact);
          const item = facts?.items.find(value => value.id === command.item);
          if (!facts || !item) continue;
          const operation = item.origin.kind === "proposal" ? "dispatch_feedback" : "direct_correction";
          if (Object.values(review.decisions).some(decision => decision.operation === operation && decision.on === target.artifact)) {
            selected = { facts, item, operation };
            break;
          }
        }
        if (!selected) return reject("feedback item or dispatch operation not found");
        if (selected.facts.approval) return reject("approval is final; it cannot be withdrawn or replaced");
        const check = { operation: selected.operation, item: selected.item, target: { unit, artifact: target.artifact, revision: target.id },
          instruction: command.instruction, recipients: command.recipients, stage_agent_workers: stageAgents(stage) };
        const recipients = validateRecipients(check);
        if (!recipients.ok) return reject(recipients.error.detail);
        id = selectAuthorizationId(check);
        const authorization: DispatchAuthorization = { id, item: selected.item.id, target: check.target, operation: check.operation,
          instruction: check.instruction, recipients: check.recipients.toSorted(), policy: "operator_required", authorized_by: writer.subject ?? "local-control" };
        writes = { authorizations: [authorization] };
      }
      await writeAssessmentFacts(trx, run_id, writes);
      const result = { kind: "committed" as const, event_id: id };
      await storeReceipt(trx, { request, unit_id: unit, digest, result });
      return ok(result);
    });
  } catch (cause) {
    return traced("commit_assessment_mutation", run_id, String(cause));
  }
}


// Reconciliation and the retry commit succeed or fail under the same run lock.
export async function commitExecutionMutation(deps: CommitDependencies, request: Parameters<typeof mutateKeyedExecution>[1], writer: Writer) {
  const result = await mutateKeyedExecution(deps.db, request, async (trx, worker) => {
    const run_id = request.run_id as RunId;
    const retry = await commitToRun(trx, deps.core, { run_id, ingress_id: scopeIngressId(writer, `execution-retry:${request.key}:${request.request_id}`), writer,
      execution_reconciliation: request.key, event: { kind: "retry_requested", unit: request.unit_id, worker } });
    if (!retry.ok) throw new Error(retry.error.error.detail);
    if (retry.value.kind === "committed") return { event_id: retry.value.event_id };
    return { reason: retry.value.kind === "rejected" ? retry.value.reason : `retry ${retry.value.kind}` };
  });
  if (result.kind === "ok" && request.mutation.kind === "reconcile") deps.wake(request.run_id as RunId);
  return result;
}
