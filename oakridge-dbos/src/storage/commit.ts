import { createHash } from "node:crypto";
import type { CoreClient } from "../core-client/client";
import { compileWorkflow, selectWanted, type CompiledAgainst, type WantedForUnit } from "../core-client/client";
import { VALIDATION_REVIEW, type BlockedReason, type CodeOperation, type CompiledWorkflow, type Event, type Incoming, type ParsedWorkflow, type StepSnapshot, type StepResult, type UnitStatus, type Writer, type Workflow } from "../core-client/core-types";
import { selectEffectInstruction, type RunWorkerAction } from "../domain/effect-instruction";
import type { RunConfig } from "../domain/run-config";
import { isTerminalStatus } from "../domain/unit-status";
import { renderTemplate } from "../domain/prompt-template";
import type { ActionId, DefinitionBundleId, IngressId, ProjectId, RunId, TracedError, UnitId, Result } from "../domain/primitives";
import type { CommitFaultNotice } from "../projections/operator-event";
import { selectRunEventFields, type RunEvent, type RunEventFields } from "../projections/run-event";
import { selectUnitTree } from "../projections/unit-label";
import { anyOf, jsonText, type Database, type DatabaseTransaction } from "./database";
import type { CommitReceipt, ReviewPrompt, ReviewPrompts, StallRecord, WantedWorkers } from "./json-column-types";
import { readPromptTexts } from "./registry-store";
import { START_OWED_STATUSES } from "./executor-store";
import { readStepSnapshot } from "./snapshot-store";

/** An event as ingress hands it over: the writer is resolved from the credential, never the body. */
export interface CommitRequest {
  readonly run_id: RunId;
  readonly ingress_id: string | null;
  readonly event: Event;
  readonly writer: Writer;
  /** Required with `launched`: the run is created pinned to this definition. */
  readonly launch?: { readonly definition_bundle_id: DefinitionBundleId; readonly project_id: ProjectId | null; readonly config: RunConfig | null };
  /**
   * Only with `worker_started`: the sha256 hex of the publication secret minted
   * for the attempt's session. Commit stores it on the attempt, and publish
   * resolves its writer from it (part 1 §7.2).
   */
  readonly publication_secret_hash?: string | null;
}
export type CommitOutcome =
  | { readonly kind: "committed"; readonly event_id: string }
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

/** Canonical JSON: object keys sorted, so a replay matches regardless of key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as { readonly [key: string]: unknown })[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
/** A launch's definition, project and config are part of what it asks for: a replay naming another is other content. */
export function requestDigest(request: Pick<CommitRequest, "event" | "writer" | "publication_secret_hash" | "launch">): string {
  const { event, writer, publication_secret_hash, launch } = request;
  return createHash("sha256").update(canonical({ event, writer, ...(publication_secret_hash ? { publication_secret_hash } : {}),
    ...(launch ? { launch } : {}) })).digest("hex");
}

/**
 * The single writer of workflow state (part 1 §6.2). Under the run row lock it
 * answers a replayed ingress id from its receipt, steps the core over the
 * step snapshot, and writes the event with its writer, the state delta, the
 * effect instructions for newly wanted workers, the wanted log, the receipt
 * and the operator event, in one transaction. A step rejection is stored, not
 * rolled back. The executor is woken after commit.
 */
export async function commitEvent(deps: CommitDependencies, request: CommitRequest): Promise<CommitResult> {
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
  let latest = trx.selectFrom("authority.event").select("id").where("run_id", "=", run_id);
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
  const created = await trx.insertInto("authority.run").values({ id: request.run_id, definition_bundle_id: launch.definition_bundle_id,
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
  const run = await trx.selectFrom("authority.run").select(["id", "definition_bundle_id", "config"])
    .where("id", "=", run_id).forUpdate().executeTakeFirst();
  if (!run) return { ok: true, value: { kind: "missing", detail: "run not found" } };
  if (request.launch && run.definition_bundle_id !== request.launch.definition_bundle_id)
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
  const definition = await trx.selectFrom("authority.definition_bundle").select(["digest", "source", "checked_program", "prompts"])
    .where("id", "=", run.definition_bundle_id).executeTakeFirst();
  if (!definition) return { ok: false, error: fault(run_id, `pinned definition ${run.definition_bundle_id} is missing`) };
  const snapshot = await readStepSnapshot(trx, run_id, unit_id.value);
  if (!snapshot) return reject(`unit ${unit_id.value} is not part of run ${run_id}`, null);
  const incoming: Incoming = { event: request.event, writer: request.writer, ingress_id: request.ingress_id };
  const stepped = await stepPinned(trx, core, { run_id, definition, snapshot, incoming });
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
  const existing = await readCommitExisting(trx, { request, digest, unit_id: unit_id.value, source: definition.source,
    parsed_workflow: definition.checked_program.workflow,
    prompts: definition.prompts, config: run.config, step: stepped.value.step });
  const planned = selectCommitPlan(snapshot, stepped.value.step, existing);
  if (!planned.ok) return { ok: false, error: fault(run_id, planned.error.detail) };
  await applyCommitPlan(trx, planned.value);
  await storeReceipt(trx, { request, unit_id: unit_id.value, digest,
    result: { kind: "committed", event_id: planned.value.event_id } });
  return { ok: true, value: { kind: "committed", event_id: planned.value.event_id } };
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
  readonly definition: { readonly digest: string; readonly source: Workflow; readonly checked_program: CompiledWorkflow; readonly prompts: { readonly [path: string]: string } };
  readonly snapshot: StepSnapshot;
  readonly incoming: Incoming;
}
type Stepped =
  | { readonly kind: "stepped"; readonly step: StepResult }
  | { readonly kind: "rejected"; readonly reason: string }
  /** The event was refused because advancing the run past it stopped at `unit`. */
  | { readonly kind: "stalled"; readonly unit: string; readonly reason: string };
/** The operations a definition was pinned under; definitions pinned before they were recorded have none. */
const pinnedOperations = (compiled: CompiledWorkflow): readonly CodeOperation[] | undefined =>
  (compiled as Partial<Pick<CompiledAgainst, "operations">>).operations;

/**
 * Step against the pinned program, compiling it from its pinned source,
 * prompts and operations when the core has not cached it. The pinned
 * operations, not today's registry, so a changed operation contract never
 * strands a run that is already pinned.
 */
async function stepPinned(trx: DatabaseTransaction, core: CoreClient, input: StepInput): Promise<Result<Stepped, CommitFault>> {
  const step = () => core.request("step", { workflow_digest: input.definition.digest, snapshot: input.snapshot, incoming: input.incoming });
  let response = await step();
  if (!response.ok && response.error.kind === "domain" && response.error.detail.kind === "unknown_bundle") {
    const texts = await readPromptTexts(trx, Object.values(input.definition.prompts));
    const prompts = Object.fromEntries(Object.entries(input.definition.prompts).flatMap(([path, digest]) => {
      const text = texts.get(digest);
      return text === undefined ? [] : [[path, text]];
    }));
    const compiled = await compileWorkflow(core, { workflow: input.definition.source, prompts,
      operations: pinnedOperations(input.definition.checked_program) });
    if (!compiled.ok) return { ok: false, error: fault(input.run_id, `pinned definition no longer compiles: ${compiled.error.detail}`) };
    if (compiled.value.digest !== input.definition.digest) return { ok: false, error: fault(input.run_id,
      `pinned definition compiles to ${compiled.value.digest}, not ${input.definition.digest}`) };
    response = await step();
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
    const { status: _old_status, input: old_input, ...old_fixed } = old;
    const { status: _status, input, ...fixed } = unit;
    if (canonical(old_fixed) !== canonical(fixed)) return `unit ${old.id} changed its declaration, parent, stage, pool or dependencies`;
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
    input: unit.input === null ? null : jsonText(unit.input), status: jsonText(unit.status) }).execute();
  for (const unit of plan.created_units) for (const depends_on_id of unit.after)
    await trx.insertInto("authority.unit_dependency").values({ run_id, unit_id: unit.id, depends_on_id }).execute();
  for (const unit of plan.changed_units) await trx.updateTable("authority.unit").set({ status: jsonText(unit.status),
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
  readonly source: Workflow;
  readonly parsed_workflow?: import("../core-client/core-types").ParsedWorkflow;
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
function reviewPromptPath(source: Workflow, parsed: ParsedWorkflow | undefined, stage: string | null, review: string): string | null {
  if (stage === null) return null;
  return parsed?.stages[stage]?.reviews?.[review]?.prompt
    ?? source.stages[stage]?.reviews?.[review]?.prompt ?? null;
}
async function readCommitExisting(trx: DatabaseTransaction, input: CommitReadInput): Promise<CommitExisting> {
  const { request, step, source, parsed_workflow, prompts } = input;
  const unit_ids = step.snapshot.units.map((unit) => unit.id);
  const wanted = selectWanted(step);
  const paths = step.reviews.flatMap((review) => {
    const kind = step.snapshot.units.find((unit) => unit.id === review.unit)?.kind;
    const stage = kind?.kind === "stage" ? kind.stage : null;
    const path = reviewPromptPath(source, parsed_workflow, stage, review.review);
    return path ? [path] : [];
  });
  const [intent_rows, review_rows, logged_rows, prompt_texts] = await Promise.all([
    unit_ids.length ? trx.selectFrom("authority.effect_intent").select("action_id").where("run_id", "=", request.run_id)
      .where("unit_id", "=", anyOf(unit_ids)).execute() : Promise.resolve([]),
    unit_ids.length ? trx.selectFrom("authority.unit").select(["id", "review_prompts", "blocked_reason"]).where("run_id", "=", request.run_id)
      .where("id", "=", anyOf(unit_ids)).execute() : Promise.resolve([]),
    wanted.length ? trx.selectFrom("authority.wanted_log as wanted").innerJoin("authority.event as event", (join) =>
      join.onRef("event.run_id", "=", "wanted.run_id").onRef("event.id", "=", "wanted.event_id"))
      .distinctOn("wanted.unit_id").select(["wanted.unit_id", "wanted.actions"]).where("wanted.run_id", "=", request.run_id)
      .where("wanted.unit_id", "=", anyOf(wanted.map((item) => item.unit_id)))
      .orderBy("wanted.unit_id").orderBy("event.created_at", "desc").orderBy("event.id", "desc").execute() : Promise.resolve([]),
    readPromptTexts(trx, paths.flatMap((path) => prompts[path] ?? [])),
  ]);
  return { request, digest: input.digest, unit_id: input.unit_id, source,
    parsed_workflow: input.parsed_workflow, prompts, config: input.config,
    intent_actions: intent_rows.map((row) => row.action_id), review_rows, prompt_texts,
    logged_wanted: new Map(logged_rows.map((row) => [row.unit_id, row.actions])), event_id: crypto.randomUUID() };
}

interface PlannedIntent { readonly unit_id: string; readonly action_id: ActionId; readonly seq: number;
  readonly instruction: import("../domain/effect-instruction").EffectInstruction }
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
      prompts, stage: unit.kind.stage, config,
      action, seq: attempt_seq, resolved });
    if (!instruction.ok) return violation(run_id, instruction.error.detail);
    intents.push({ unit_id: worker.unit, action_id: action_id as ActionId, seq: attempt_seq, instruction: instruction.value });
    known.add(action_id);
    const replaced = selectReplacedAction(action);
    if (replaced !== null) replaced_actions.push(replaced);
  }
  const rendered = new Map<string, { [review: string]: ReviewPrompt }>();
  for (const review of step.reviews) {
    const kind = step.snapshot.units.find((unit) => unit.id === review.unit)?.kind;
    const stage = kind?.kind === "stage" ? kind.stage : null;
    const path = reviewPromptPath(source, existing.parsed_workflow, stage, review.review);
    const digest = path ? prompts[path] : undefined;
    const text = digest === undefined ? undefined : existing.prompt_texts.get(digest);
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
  for (const intent of plan.intents) await trx.insertInto("authority.effect_intent").values({ id: crypto.randomUUID(), run_id,
    unit_id: intent.unit_id, action_id: intent.action_id, seq: intent.seq, payload: jsonText(intent.instruction) }).execute();
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

interface ReceiptInput { readonly request: CommitRequest; readonly unit_id: string | null; readonly digest: string; readonly result: CommitReceipt }
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

/**
 * The one run id derivation (D8): a launch's request id names its run, so a
 * replayed launch finds its receipt. Sixteen hex characters (64 bits) of the
 * digest: every id in a run is prefixed by its run id, and 64 bits keep two
 * launches from colliding.
 */
export function launchRunId(request_id: string): RunId {
  return `run-${createHash("sha256").update(request_id).digest("hex").slice(0, 16)}` as RunId;
}
