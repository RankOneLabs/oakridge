import { createHash } from "node:crypto";
import type { CoreClient } from "../core-client/client";
import { compileWorkflow, selectWanted } from "../core-client/client";
import type { Event, Incoming, ResolvedRunWorker, StepSnapshot, StepResult, Writer } from "../core-client/core-types";
import { selectEffectInstruction, type RunWorkerAction } from "../domain/effect-instruction";
import type { RunConfig } from "../domain/run-config";
import { renderTemplate } from "../domain/prompt-template";
import type { DefinitionBundleId, ProjectId, RunId, TracedError, UnitId } from "../domain/primitives";
import type { CommitFaultNotice } from "../projections/operator-event";
import { selectRunEvent } from "../projections/run-event";
import { anyOf, jsonText, type Database, type DatabaseTransaction } from "./database";
import type { CommitReceipt, ReviewPrompts, StallRecord } from "./json-column-types";
import { readPromptTexts } from "./registry-store";
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
  | { readonly kind: "missing"; readonly detail: string };
export interface CommitDependencies {
  readonly db: Database;
  readonly core: CoreClient;
  /** Called after a committed event; the executor re-reads the run. */
  readonly wake: (run_id: RunId) => void;
}
export type CommitResult = { readonly ok: true; readonly value: CommitOutcome } | { readonly ok: false; readonly error: TracedError };

/** A fault inside the transaction: it rolls back and surfaces as an error, never as a stored outcome. */
class CommitFault extends Error {
  constructor(readonly error: TracedError) { super(error.detail); }
}
const fault = (run_id: string, detail: string): CommitFault => new CommitFault({ operation: "commit_event", entity_id: run_id, detail });

/** Canonical JSON: object keys sorted, so a replay matches regardless of key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as { readonly [key: string]: unknown })[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function requestDigest(request: Pick<CommitRequest, "event" | "writer" | "publication_secret_hash">): string {
  const { event, writer, publication_secret_hash } = request;
  return createHash("sha256").update(canonical(publication_secret_hash ? { event, writer, publication_secret_hash } : { event, writer })).digest("hex");
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
  try {
    const outcome = await deps.db.transaction().execute((trx) => commitInTransaction(trx, deps.core, scoped));
    if (outcome.kind === "committed") deps.wake(request.run_id);
    return { ok: true, value: outcome };
  } catch (error) {
    if (error instanceof CommitFault) return { ok: false, error: await recordCommitFault(deps.db, scoped, error.error) };
    const conflict = concurrencyConflict(error);
    if (conflict) return { ok: true, value: { kind: "conflict", detail: conflict } };
    return { ok: false, error: { operation: "commit_event", entity_id: request.run_id, detail: String(error) } };
  }
}

/**
 * Ingress ids are chosen by their writer, so each writer gets its own
 * namespace: an operator or an agent cannot claim the id the executor will
 * report an attempt under, and one session cannot claim another's.
 */
export function scopeIngressId(writer: Writer, ingress_id: string | null): string | null {
  if (ingress_id === null) return null;
  switch (writer.kind) {
    case "session": return `session:${writer.session}:${ingress_id}`;
    case "operator": case "executor": case "engine": return `${writer.kind}:${ingress_id}`;
  }
}

/**
 * A fault rolled its transaction back, so it is recorded against the run in
 * a transaction of its own (D-V4): the run's attention shows it until a later
 * event commits on its unit. A launch that faulted left no run to record it on.
 * Returns the fault, naming a failure to record it.
 */
async function recordCommitFault(db: Database, request: CommitRequest, fault: TracedError): Promise<TracedError> {
  try {
    await db.transaction().execute(async (trx) => {
      const run = await trx.selectFrom("authority.run").select("id").where("id", "=", request.run_id)
        .where("root_unit_id", "is not", null).executeTakeFirst();
      if (!run) return;
      const affected = await affectedUnit(trx, request.run_id, request.event);
      const unit_id = affected.ok ? affected.value as UnitId | null : null;
      const notice: CommitFaultNotice = { run_id: request.run_id, unit_id, ingress_id: request.ingress_id, event: request.event,
        detail: fault.detail, after_event: await readLatestEventId(trx, request.run_id, unit_id) };
      await trx.insertInto("authority.operator_event").values({ id: crypto.randomUUID(), run_id: request.run_id, run_key: request.run_id,
        event_key: "commit_fault", payload: jsonText({ kind: "commit_fault", data: notice }) }).execute();
    });
    return fault;
  } catch (cause) {
    return { ...fault, detail: `${fault.detail} (recording the fault failed: ${String(cause)})` };
  }
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
  return error.code === "40P01" || error.code === "40001" ? `database concurrency conflict (${error.code}); retry the event` : null;
}

async function commitInTransaction(trx: DatabaseTransaction, core: CoreClient, request: CommitRequest): Promise<CommitOutcome> {
  const { run_id } = request;
  if (request.publication_secret_hash && request.event.kind !== "worker_started")
    throw fault(run_id, `a publication secret hash rides only on worker_started, not ${request.event.kind}`);
  if (request.event.kind === "launched") {
    if (!request.launch) return { kind: "missing", detail: "a launch names its pinned definition" };
    await trx.insertInto("authority.run").values({ id: run_id, definition_bundle_id: request.launch.definition_bundle_id,
      project_id: request.launch.project_id, config: request.launch.config === null ? null : jsonText(request.launch.config) })
      .onConflict((conflict) => conflict.column("id").doNothing()).execute();
  }
  const run = await trx.selectFrom("authority.run").select(["id", "definition_bundle_id", "config"])
    .where("id", "=", run_id).forUpdate().executeTakeFirst();
  if (!run) return { kind: "missing", detail: "run not found" };
  if (request.launch && run.definition_bundle_id !== request.launch.definition_bundle_id)
    return { kind: "conflict", detail: "run is pinned to a different definition" };
  const digest = requestDigest(request);
  if (request.ingress_id !== null) {
    const receipt = await trx.selectFrom("authority.ingress_receipt").select(["request_digest", "result"])
      .where("run_id", "=", run_id).where("ingress_id", "=", request.ingress_id).executeTakeFirst();
    if (receipt) return receipt.request_digest === digest ? { kind: "replayed", receipt: receipt.result }
      : { kind: "conflict", detail: "ingress id reused with different content" };
  }
  const unit_id = await affectedUnit(trx, run_id, request.event);
  // The receipt names a unit only once the unit is known to exist: its foreign key would refuse any other.
  const reject = async (reason: string, receipt_unit: string | null): Promise<CommitOutcome> => {
    await storeReceipt(trx, { request, unit_id: receipt_unit, digest, result: { kind: "rejected", reason } });
    return { kind: "rejected", reason };
  };
  if (!unit_id.ok) return reject(unit_id.reason, null);
  const definition = await trx.selectFrom("authority.definition_bundle").select(["digest", "source", "prompts"])
    .where("id", "=", run.definition_bundle_id).executeTakeFirst();
  if (!definition) throw fault(run_id, `pinned definition ${run.definition_bundle_id} is missing`);
  const snapshot = await readStepSnapshot(trx, run_id, unit_id.value);
  if (!snapshot) return reject(`unit ${unit_id.value} is not part of run ${run_id}`, null);
  const incoming: Incoming = { event: request.event, writer: request.writer, ingress_id: request.ingress_id };
  const stepped = await stepPinned(trx, core, { run_id, definition, snapshot, incoming });
  if (stepped.kind === "rejected") return reject(stepped.reason, unit_id.value);
  if (stepped.kind === "stalled") {
    // The event is refused as any rejection is, and the refusal records where the run stopped (D-V4).
    const reason = `run stalled at ${stepped.unit}: ${stepped.reason}`;
    const stall: StallRecord = { unit_id: stepped.unit, event: request.event, after_event: await readLatestEventId(trx, run_id, unit_id.value),
      refused_at: new Date().toISOString() };
    await storeReceipt(trx, { request, unit_id: unit_id.value, digest, result: { kind: "rejected", reason, stall } });
    await trx.insertInto("authority.operator_event").values({ id: crypto.randomUUID(), run_id, run_key: run_id, event_key: "invalidate",
      payload: jsonText({ kind: "invalidate", data: { target: "run", run_id } }) }).execute();
    return { kind: "rejected", reason };
  }
  const step = stepped.step;
  const violation = selectDeltaViolation(snapshot, step.snapshot);
  if (violation !== null) throw fault(run_id, `step changed state commit does not write: ${violation}`);
  await writeDelta(trx, run_id, snapshot, step.snapshot);
  if (request.event.kind === "worker_started" && request.publication_secret_hash)
    await storePublicationSecret(trx, { run_id, action_id: request.event.action, hash: request.publication_secret_hash, after: step.snapshot });
  const event = await trx.insertInto("authority.event").values({ id: crypto.randomUUID(), run_id, unit_id: unit_id.value,
    ingress_id: request.ingress_id, payload: jsonText(request.event), writer: jsonText(request.writer) })
    .returning(["id", "created_at"]).executeTakeFirstOrThrow();
  await reconcileIntents(trx, { run_id, source: definition.source, prompts: definition.prompts, config: run.config, step });
  const newly_awaiting = await writeReviewPrompts(trx, { run_id, source: definition.source, prompts: definition.prompts, step });
  for (const { unit_id: unit, actions } of selectWanted(step))
    await trx.insertInto("authority.wanted_log").values({ id: crypto.randomUUID(), run_id, unit_id: unit, event_id: event.id,
      actions: jsonText(actions) }).execute();
  await storeReceipt(trx, { request, unit_id: unit_id.value, digest, result: { kind: "committed", event_id: event.id } });
  // A launch or a cancel addresses the whole run: its event names the root unit.
  const addressed = step.snapshot.units.find((unit) => unit.id === (unit_id.value ?? step.snapshot.run.root));
  if (!addressed) throw fault(run_id, `event ${event.id} addresses no unit of the run`);
  const run_event = selectRunEvent({ event_id: event.id, run_id, kind: request.event.kind, occurred_at: new Date(event.created_at),
    run_status: step.snapshot.run.status, workflow: definition.source,
    unit: { id: addressed.id as UnitId, unit_key: addressed.declaration, collection_key: collectionKey(addressed), stage: addressed.stage ?? null,
      status: addressed.status },
    newly_awaiting: newly_awaiting.get(addressed.id) ?? [] });
  await trx.insertInto("authority.operator_event").values({ id: crypto.randomUUID(), run_id, run_key: run_id, event_key: "run_event",
    payload: jsonText({ kind: "run_event", data: run_event }) }).execute();
  return { kind: "committed", event_id: event.id };
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
  readonly definition: { readonly digest: string; readonly source: import("../core-client/core-types").Workflow; readonly prompts: { readonly [path: string]: string } };
  readonly snapshot: StepSnapshot;
  readonly incoming: Incoming;
}
type Stepped =
  | { readonly kind: "stepped"; readonly step: StepResult }
  | { readonly kind: "rejected"; readonly reason: string }
  /** The event was refused because advancing the run past it stopped at `unit`. */
  | { readonly kind: "stalled"; readonly unit: string; readonly reason: string };
/** Step against the pinned program, compiling it from its pinned source and prompts when the core has not cached it. */
async function stepPinned(trx: DatabaseTransaction, core: CoreClient, input: StepInput): Promise<Stepped> {
  const step = () => core.request("step", { workflow_digest: input.definition.digest, snapshot: input.snapshot, incoming: input.incoming });
  let response = await step();
  if (!response.ok && response.error.kind === "domain" && response.error.detail.kind === "unknown_bundle") {
    const texts = await readPromptTexts(trx, Object.values(input.definition.prompts));
    const prompts = Object.fromEntries(Object.entries(input.definition.prompts).flatMap(([path, digest]) => {
      const text = texts.get(digest);
      return text === undefined ? [] : [[path, text]];
    }));
    const compiled = await compileWorkflow(core, { workflow: input.definition.source, prompts });
    if (!compiled.ok) throw fault(input.run_id, `pinned definition no longer compiles: ${compiled.error.detail}`);
    if (compiled.value.digest !== input.definition.digest) throw fault(input.run_id, `pinned definition compiles to ${compiled.value.digest}, not ${input.definition.digest}`);
    response = await step();
  }
  if (!response.ok) {
    if (response.error.kind === "domain" && response.error.detail.kind === "rejected_event")
      return { kind: "rejected", reason: response.error.detail.detail };
    if (response.error.kind === "domain" && response.error.detail.kind === "stalled_event")
      return { kind: "stalled", unit: response.error.detail.entity_id, reason: response.error.detail.detail };
    throw fault(input.run_id, `core step failed: ${JSON.stringify(response.error)}`);
  }
  if (response.value.kind !== "stepped") throw fault(input.run_id, "core returned a non-step output");
  return { kind: "stepped", step: response.value.value };
}

/** A collection member's key is its id below its parent; a fixed unit has none. */
function collectionKey(unit: StepSnapshot["units"][number]): string | null {
  if (unit.parent == null) return null;
  const member = unit.id.slice(unit.parent.length + 1);
  return member === unit.declaration ? null : member;
}

/**
 * What writeDelta does not write must not change: it writes new rows, unit
 * status, a unit's input when it first resolves, and an attempt's status,
 * end and session. Anything else step changes would be silently lost, so it
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

/** Write what step changed: run, new units and edges, unit statuses and inputs, attempts, revisions and decisions. */
async function writeDelta(trx: DatabaseTransaction, run_id: string, before: StepSnapshot, after: StepSnapshot): Promise<void> {
  await trx.updateTable("authority.run").set((eb) => ({ root_unit_id: after.run.root, input: jsonText(after.run.input ?? null),
    status: jsonText(after.run.status), version: eb("version", "+", 1) })).where("id", "=", run_id).execute();
  const known = new Map(before.units.map((unit) => [unit.id, unit]));
  // Parents first: a member's foreign key names its parent.
  const created = after.units.filter((unit) => !known.has(unit.id)).sort((left, right) => left.id.split("/").length - right.id.split("/").length);
  for (const unit of created) await trx.insertInto("authority.unit").values({ id: unit.id, run_id, parent_id: unit.parent ?? null,
    unit_key: unit.declaration, collection_key: collectionKey(unit), declaration: unit.declaration, stage: unit.stage ?? null,
    pool: unit.pool ?? null, input: jsonText(unit.input), status: jsonText(unit.status) }).execute();
  for (const unit of created) for (const depends_on_id of unit.after)
    await trx.insertInto("authority.unit_dependency").values({ run_id, unit_id: unit.id, depends_on_id }).execute();
  // A unit created waiting resolves its input when it starts, possibly in a later step than the one that created it.
  for (const unit of after.units) {
    const old = known.get(unit.id);
    if (old && (canonical(old.status) !== canonical(unit.status) || canonical(old.input) !== canonical(unit.input)))
      await trx.updateTable("authority.unit")
        .set((eb) => ({ status: jsonText(unit.status), input: jsonText(unit.input), version: eb("version", "+", 1) }))
        .where("run_id", "=", run_id).where("id", "=", unit.id).execute();
  }
  const old_attempts = new Map(before.attempts.map((attempt) => [`${attempt.action_id}#${attempt.seq}`, attempt]));
  for (const attempt of after.attempts) {
    const old = old_attempts.get(`${attempt.action_id}#${attempt.seq}`);
    if (!old) await trx.insertInto("authority.attempt").values({ action_id: attempt.action_id, seq: attempt.seq, run_id,
      unit_id: attempt.unit, worker: attempt.worker, mode: jsonText(attempt.mode), cause: jsonText(attempt.cause),
      status: jsonText(attempt.status), ended_at: attempt.ended_at, kbbl_session_id: attempt.kbbl_session_id ?? null }).execute();
    else if (canonical(old) !== canonical(attempt)) await trx.updateTable("authority.attempt")
      .set({ status: jsonText(attempt.status), ended_at: attempt.ended_at, kbbl_session_id: attempt.kbbl_session_id ?? null })
      .where("action_id", "=", attempt.action_id).where("seq", "=", attempt.seq).execute();
  }
  const old_revisions = new Set(before.revisions.map((revision) => revision.id));
  for (const revision of after.revisions) if (!old_revisions.has(revision.id))
    await trx.insertInto("authority.artifact_revision").values({ id: revision.id, run_id, unit_id: revision.unit, artifact: revision.artifact,
      body: jsonText(revision.body), by_id: revision.by, predecessor_id: revision.predecessor ?? null, subject: revision.subject ?? null }).execute();
  const old_decisions = new Set(before.decisions.map((decision) => decision.id));
  for (const decision of after.decisions) if (!old_decisions.has(decision.id))
    await trx.insertInto("authority.review_decision").values({ id: decision.id, run_id, unit_id: decision.unit, review: decision.review,
      decision: decision.decision, effect: decision.effect, target_revision_id: decision.target, payload: jsonText(decision.payload) }).execute();
}

interface PublicationSecret { readonly run_id: string; readonly action_id: string; readonly hash: string; readonly after: StepSnapshot }
/** The started attempt is the action's latest; a periodic worker's start may have opened a new seq. */
async function storePublicationSecret(trx: DatabaseTransaction, input: PublicationSecret): Promise<void> {
  const started = input.after.attempts.filter((attempt) => attempt.action_id === input.action_id)
    .reduce<StepSnapshot["attempts"][number] | null>((latest, attempt) => latest && latest.seq > attempt.seq ? latest : attempt, null);
  if (!started) throw fault(input.run_id, `started action ${input.action_id} has no attempt`);
  await trx.updateTable("authority.attempt").set({ publication_secret_hash: input.hash })
    .where("run_id", "=", input.run_id).where("action_id", "=", started.action_id).where("seq", "=", started.seq).execute();
}

interface Reconcile {
  readonly run_id: string;
  readonly source: import("../core-client/core-types").Workflow;
  readonly prompts: { readonly [path: string]: string };
  readonly config: RunConfig | null;
  readonly step: StepResult;
}
/**
 * Diff the external actions step wants against effect_intent. The core wants a
 * RunWorker until its attempt exists, so a wanted action with no intent gets
 * one, carrying its effect instruction. A periodic worker's new watch
 * requests the stop of the action it replaces. An intent whose unit is no
 * longer active (done or cancelled) is still in effect but no longer wanted,
 * so its stop is requested. An intent the executor has settled is left alone.
 */
async function reconcileIntents(trx: DatabaseTransaction, input: Reconcile): Promise<void> {
  const { run_id, step } = input;
  const unit_ids = step.snapshot.units.map((unit) => unit.id);
  if (unit_ids.length === 0) return;
  const wanted = selectWanted(step)
    .flatMap(({ actions }) => actions.filter((action): action is RunWorkerAction => action.kind === "run_worker"));
  const resolved = new Map<string, ResolvedRunWorker>(step.resolved.map((item) => [item.action_id, item]));
  // One intent per action: a watch's later attempts reuse its action id, and its carrier
  // starts each one (WorkerStarted on an ended periodic attempt opens the next seq).
  const existing = new Set((await trx.selectFrom("authority.effect_intent").select("action_id")
    .where("run_id", "=", run_id).where("unit_id", "=", anyOf(unit_ids)).execute()).map((row) => row.action_id));
  for (const action of wanted) {
    // step adds the attempt for a newly wanted action; its key names the resolved inputs.
    const attempt = step.snapshot.attempts.filter((candidate) => candidate.unit === action.unit && candidate.worker === action.worker
      && canonical(candidate.mode) === canonical(action.mode) && canonical(candidate.cause) === canonical(action.cause)).at(-1);
    const inputs = attempt ? resolved.get(attempt.action_id) : undefined;
    if (!attempt || !inputs) throw fault(run_id, `wanted worker ${action.unit}/${action.worker} has no attempt or resolved inputs`);
    if (existing.has(inputs.action_id)) continue;
    const unit = step.snapshot.units.find((candidate) => candidate.id === action.unit);
    if (!unit?.stage) throw fault(run_id, `wanted worker ${action.unit}/${action.worker} is not on a stage`);
    const instruction = selectEffectInstruction({ run_id, workflow: input.source, prompts: input.prompts, stage: unit.stage, config: input.config,
      action, seq: attempt.seq, resolved: inputs });
    if (!instruction.ok) throw fault(run_id, instruction.error.detail);
    await trx.insertInto("authority.effect_intent").values({ id: crypto.randomUUID(), run_id, unit_id: action.unit,
      action_id: inputs.action_id, seq: attempt.seq, payload: jsonText(instruction.value) }).execute();
    existing.add(inputs.action_id);
    // A new watch replaces the worker's previous action (D-V1): its carrier stops repeating.
    const replaced = selectReplacedAction(action);
    if (replaced !== null) await trx.updateTable("authority.effect_intent").set({ status: "stop_requested", updated_at: new Date() })
      .where("run_id", "=", run_id).where("action_id", "=", replaced).where("status", "in", ["pending", "acknowledged"]).execute();
  }
  const inactive = step.snapshot.units.filter((unit) => unit.status.kind === "done" || unit.status.kind === "cancelled").map((unit) => unit.id);
  if (inactive.length) await trx.updateTable("authority.effect_intent").set({ status: "stop_requested", updated_at: new Date() })
    .where("run_id", "=", run_id).where("unit_id", "=", anyOf(inactive)).where("status", "in", ["pending", "acknowledged"]).execute();
}

/** The action a periodic worker's new watch replaces; null for any other action, or a first watch. */
export function selectReplacedAction(action: RunWorkerAction): string | null {
  return action.cause.kind === "periodic" ? action.cause.replaces ?? null : null;
}

/**
 * Render each operator review a decision is legal on now with the inputs step
 * resolved for it (part 1 §2.3: the inbox shows `prompt` with the review's
 * resolved inputs), and keep it on its unit. A unit whose reviews are all
 * decided, or that is no longer active, keeps none. Only a changed set is
 * written. Returns, per unit, the reviews that began awaiting with this event.
 */
async function writeReviewPrompts(trx: DatabaseTransaction, input: Omit<Reconcile, "config">): Promise<ReadonlyMap<string, readonly string[]>> {
  const { run_id, step, source } = input;
  const newly_awaiting = new Map<string, readonly string[]>();
  const stage_units = step.snapshot.units.filter((unit) => unit.stage != null);
  if (stage_units.length === 0) return newly_awaiting;
  const paths = step.reviews.flatMap((review) => {
    const stage = stage_units.find((unit) => unit.id === review.unit)?.stage;
    const path = stage ? source.stages[stage]?.reviews?.[review.review]?.prompt : null;
    return path ? [path] : [];
  });
  const texts = await readPromptTexts(trx, paths.flatMap((path) => input.prompts[path] ?? []));
  const rendered = new Map<string, { [review: string]: { readonly target: string; readonly prompt: string } }>();
  for (const review of step.reviews) {
    const stage = stage_units.find((unit) => unit.id === review.unit)?.stage;
    const path = stage ? source.stages[stage]?.reviews?.[review.review]?.prompt : null;
    const digest = path ? input.prompts[path] : undefined;
    const text = digest === undefined ? undefined : texts.get(digest);
    if (text === undefined) throw fault(run_id, `review ${review.review} on ${review.unit} has no pinned prompt text`);
    const inputs = typeof review.inputs === "object" && review.inputs !== null ? review.inputs as { readonly [key: string]: unknown } : {};
    const unit = rendered.get(review.unit) ?? {};
    unit[review.review] = { target: review.target, prompt: renderTemplate(text, inputs) };
    rendered.set(review.unit, unit);
  }
  const current = await trx.selectFrom("authority.unit").select(["id", "review_prompts"]).where("run_id", "=", run_id)
    .where("id", "=", anyOf(stage_units.map((unit) => unit.id))).execute();
  for (const row of current) {
    const next: ReviewPrompts = rendered.get(row.id) ?? {};
    if (canonical(next) === canonical(row.review_prompts)) continue;
    await trx.updateTable("authority.unit").set({ review_prompts: jsonText(next) }).where("run_id", "=", run_id).where("id", "=", row.id).execute();
    const began = Object.keys(next).filter((review) => row.review_prompts[review]?.target !== next[review]?.target).sort();
    if (began.length > 0) newly_awaiting.set(row.id, began);
  }
  return newly_awaiting;
}

interface ReceiptInput { readonly request: CommitRequest; readonly unit_id: string | null; readonly digest: string; readonly result: CommitReceipt }
async function storeReceipt(trx: DatabaseTransaction, input: ReceiptInput): Promise<void> {
  if (input.request.ingress_id === null) return;
  await trx.insertInto("authority.ingress_receipt").values({ id: crypto.randomUUID(), run_id: input.request.run_id, unit_id: input.unit_id,
    ingress_id: input.request.ingress_id, request_digest: input.digest, result: jsonText(input.result) }).execute();
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
