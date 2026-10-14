import { DBOS, Error as DBOSErrors, type WorkflowStatus } from "@dbos-inc/dbos-sdk";
import type { CoreClient } from "../core-client/client";
import type { WorkerResult } from "../core-client/core-types";
import { decodeEffectInstruction, selectEverySeconds, type EffectInstruction } from "../domain/effect-instruction";
import type { RunId } from "../domain/primitives";
import { bounded, resolveObserve, resolveStart, resolveStop, type WorkerFailure } from "../effects/outcomes";
import type { EffectProvider, ExternalHandle, ProviderResult, SessionMaterial } from "../effects/provider";
import { HANDLE_KINDS, PROVIDER_ERROR_CODES } from "../effects/provider-catalog";
import { renderSessionTask, selectSessionTaskContext } from "../effects/session-prompt";
import type { OperationOutcome } from "../operations/outcome";
import type { OperationRunner } from "../operations/runner";
import type { Database } from "../storage/database";
import { abandonIntent, claimStart, listOwedIntents, markAcknowledged, readAttemptSession, readIntent, readLatestAttempt, recordTryFailure, settleIntent,
  type EffectStatus, type LatestAttempt, type SettledStatus, type StartClaim, type StopOrigin } from "../storage/executor-store";
import { listRunsNeedingWork, readLatestRevisionId, readRunStanding, readSessionHistory } from "../storage/read-store";
import { readPromptTexts } from "../storage/registry-store";
import { reportWorker, type ExecutorReport } from "./executor-ingress";

/**
 * Three generic workflows carry every run. None of them knows a stage or a
 * worker: commit decides what is wanted and writes it as effect instructions,
 * and these workflows only carry instructions to an agent's kbbl session or a
 * registered code operation, and report what happened back to commit as
 * WorkerStarted, WorkerEnded and (for code output) RevisionPublished events. DBOS owns
 * the execution — a crash mid-step resumes at that step on the next process of
 * the same engine version. A process of a different engine version never runs
 * another version's workflows, so on boot it fences them and carries their
 * runs and intents again from the authority rows.
 *
 * The services are process-wide and registered by the composition before
 * `DBOS.launch`; a workflow step never receives a connection as an argument.
 */
export interface WorkflowServices {
  readonly db: Database;
  readonly core: CoreClient;
  /** Agent workers: their kbbl sessions. */
  readonly provider: EffectProvider;
  /** Code workers: the registered operations. */
  readonly operations: OperationRunner;
  readonly timing: WorkflowTiming;
}
/** Provider calls carry no timing here: each is bounded by its instruction's `deadline_ms`. */
export interface WorkflowTiming {
  /** First sleep after a start or stop attempt that must be repeated; doubles up to the cap. */
  readonly retry_initial_seconds: number;
  readonly retry_cap_seconds: number;
  /** Sleep between observations that report a still-running execution. */
  readonly observe_interval_seconds: number;
  /** Consecutive transiently_unavailable observations before the attempt fails. */
  readonly max_observe_unavailable_attempts: number;
  /** Bound on how long a lost wake can delay a run's recheck. */
  readonly wake_timeout_seconds: number;
  /**
   * Optional wall-clock DBOS timeout for an effect, including observation. Null
   * by default: starts are bounded by the instruction's start budget and a lost
   * session by max_observe_unavailable_attempts, so a wall clock would only end
   * an agent session that is still working.
   */
  readonly execution_deadline_ms: number | null;
  /** Loop iterations (observations, watch runs, stop tries) one carrier workflow runs before it rolls over to its successor. */
  readonly carrier_max_iterations: number;
}
export const DEFAULT_WORKFLOW_TIMING: WorkflowTiming = {
  retry_initial_seconds: 1, retry_cap_seconds: 30, observe_interval_seconds: 5,
  max_observe_unavailable_attempts: 10, wake_timeout_seconds: 30, execution_deadline_ms: null, carrier_max_iterations: 128,
};

let services: WorkflowServices | null = null;
export function registerWorkflowServices(value: WorkflowServices): void { services = value; }
function current(): WorkflowServices {
  if (!services) throw new Error("workflow services are not registered");
  return services;
}

export const RUN_WAKE_TOPIC = "oakridge-run-wake";
const RUN_WORKFLOW_NAME = "oakridgeRunWorkflow";
const EFFECT_WORKFLOW_NAME = "oakridgeEffectWorkflow";
const CLEANUP_WORKFLOW_NAME = "oakridgeCleanupWorkflow";
/** Generation zero keeps a workflow's original address; a successor appends its generation, so two processes that roll it over start the same one. */
const generationId = (base_id: string, generation: number): string => generation === 0 ? base_id : `${base_id}:${generation}`;
/** The generation a workflow id names under its base address, or null when the id is not one of that workflow's. */
export function generationOf(base_id: string, workflow_id: string): number | null {
  if (workflow_id === base_id) return 0;
  const suffix = workflow_id.startsWith(`${base_id}:`) ? workflow_id.slice(base_id.length + 1) : null;
  return suffix !== null && /^[1-9]\d*$/.test(suffix) ? Number(suffix) : null;
}
export const runWorkflowId = (run_id: string, generation = 0): string => generationId(`run:${run_id}`, generation);
/**
 * Intent workflows are addressed per engine version: a new engine starts its
 * own carrier for an intent its predecessor parked, rather than inheriting a
 * row it can never run. The workflow's argument, not its id, names the intent.
 */
export const intentWorkflowId = (intent_id: string, application_version: string = DBOS.applicationVersion, generation = 0): string =>
  generationId(`${intent_id}@${application_version}`, generation);
/** A stop is carried by its own workflow: the intent's start carrier may have finished, or may still be observing. */
export const cleanupWorkflowId = (intent_id: string, application_version: string = DBOS.applicationVersion, generation = 0): string =>
  generationId(`${intent_id}:stop@${application_version}`, generation);
/** Which of an intent's two carriers: the one that starts and observes it, or the one that confirms its stop. */
export type CarrierKind = "start" | "stop";
export const carrierWorkflowId = (kind: CarrierKind, intent_id: string, generation = 0): string =>
  kind === "start" ? intentWorkflowId(intent_id, DBOS.applicationVersion, generation) : cleanupWorkflowId(intent_id, DBOS.applicationVersion, generation);
const CARRIER_WORKFLOW_NAMES: { readonly [kind in CarrierKind]: string } = { start: EFFECT_WORKFLOW_NAME, stop: CLEANUP_WORKFLOW_NAME };
/** DBOS dequeues and recovers only rows recorded under the running version. */
export function isFromOtherEngine(status: WorkflowStatus): boolean {
  return status.applicationVersion !== undefined && status.applicationVersion !== DBOS.applicationVersion;
}
export class RunInfrastructureError extends Error {
  override readonly name = "RunInfrastructureError";
  constructor(readonly run_id: string, readonly operation: string, readonly detail: string) {
    super(`run ${run_id}: ${operation}: ${detail}`);
  }
}
function isWorkflowCancellation(error: unknown): boolean {
  return error instanceof DBOSErrors.DBOSWorkflowCancelledError
    || error instanceof DBOSErrors.DBOSAwaitedWorkflowCancelledError;
}
const RUN_BOUNDARY_RETRIES = 5;
export const RUN_MAX_ITERATIONS = 128;
const backoff = (attempt: number, timing: WorkflowTiming): number => Math.min(timing.retry_cap_seconds, timing.retry_initial_seconds * 2 ** Math.min(attempt, 16));

// ------------------------------------------------------- run generation -----

/** The generation a run workflow id names, or null when the id is not one of this run's. */
export const runGenerationOf = (run_id: string, workflow_id: string): number | null => generationOf(runWorkflowId(run_id), workflow_id);
/**
 * A run's current generation is the newest run workflow DBOS holds for it
 * (D10: the authority keeps no generation). A successor's id is fixed by its
 * generation, so two processes that both roll a run over start the same workflow.
 */
export async function currentRunGeneration(run_id: string): Promise<number | null> {
  const workflows = await DBOS.listWorkflows({ workflowName: RUN_WORKFLOW_NAME, workflow_id_prefix: runWorkflowId(run_id), loadInput: false, loadOutput: false });
  const generations = workflows.map((status) => runGenerationOf(run_id, status.workflowID)).filter((generation) => generation !== null);
  return generations.length ? Math.max(...generations) : null;
}

/** An intent carrier's current generation under this engine version: the newest DBOS holds, with its status; null before the first. */
export async function currentCarrier(kind: CarrierKind, intent_id: string): Promise<{ readonly generation: number; readonly status: WorkflowStatus } | null> {
  const base_id = carrierWorkflowId(kind, intent_id);
  const workflows = await DBOS.listWorkflows({ workflowName: CARRIER_WORKFLOW_NAMES[kind], workflow_id_prefix: base_id, loadInput: false, loadOutput: false });
  return workflows.reduce<{ readonly generation: number; readonly status: WorkflowStatus } | null>((newest, status) => {
    const generation = generationOf(base_id, status.workflowID);
    return generation !== null && (newest === null || generation > newest.generation) ? { generation, status } : newest;
  }, null);
}

// ---------------------------------------------------------------- steps -----
// Every step is one IO boundary. Steps return values, never throw for domain
// reasons; DBOS retries only infrastructure failures (a lost connection).

interface CarriedIntent {
  readonly id: string;
  readonly run_id: RunId;
  readonly status: EffectStatus;
  /** Provider starts claimed so far; none means no execution can exist. */
  readonly tries: number;
  readonly last_error: string | null;
  /** Who requested the intent's stop, once one was requested. */
  readonly stop_origin: StopOrigin | null;
  readonly instruction: EffectInstruction;
  /** The session the attempt reported at start, so a carrier resumed by another version can observe or stop it. */
  readonly handle: ExternalHandle | null;
}
type LoadedIntent = { readonly kind: "carried"; readonly intent: CarriedIntent }
  | { readonly kind: "invalid"; readonly id: string; readonly run_id: RunId; readonly attempt: AttemptKey; readonly detail: string }
  | { readonly kind: "missing" };
const loadIntentStep = DBOS.registerStep(async (intent_id: string): Promise<LoadedIntent> => {
  const { db } = current();
  const intent = await readIntent(db, intent_id);
  if (!intent) return { kind: "missing" };
  const decoded = decodeEffectInstruction(intent.payload);
  if (!decoded.ok) return { kind: "invalid", id: intent.id, run_id: intent.run_id, attempt: { action_id: intent.action_id, seq: intent.seq }, detail: decoded.error.detail };
  const session_id = await readAttemptSession(db, decoded.value.attempt);
  return { kind: "carried", intent: { id: intent.id, run_id: intent.run_id, status: intent.status, tries: intent.tries,
    last_error: intent.last_error, stop_origin: intent.stop_origin, instruction: decoded.value,
    handle: session_id === null ? null : { kind: HANDLE_KINDS.session, session_id } } };
}, { name: "oakridgeLoadIntent", retriesAllowed: true, maxAttempts: 5 });

async function callProvider<Value>(deadline_ms: number, operation: (signal: AbortSignal) => Promise<ProviderResult<Value>>): Promise<ProviderResult<Value>> {
  const controller = new AbortController();
  let call: Promise<ProviderResult<Value>>;
  try { call = operation(controller.signal); } catch (error) { call = Promise.resolve({ kind: "uncertain", detail: String(error) }); }
  return bounded(call, deadline_ms, controller);
}
// The claim is inside the step's IO body: a re-execution before checkpointing
// claims another try rather than replaying an earlier claim.
const claimStartStep = DBOS.registerStep(async (intent: CarriedIntent): Promise<StartClaim> =>
  claimStart(current().db, { intent_id: intent.id, max_tries: intent.instruction.max_start_attempts }),
{ name: "oakridgeClaimStart", retriesAllowed: true, maxAttempts: 5 });
const startStep = DBOS.registerStep(async (instruction: EffectInstruction): Promise<ProviderResult<unknown>> =>
  callProvider(instruction.deadline_ms, (signal) => current().provider.start(instruction, { signal })), { name: "oakridgeStart" });
const observeStep = DBOS.registerStep(async (instruction: EffectInstruction, material: SessionMaterial, handle: ExternalHandle): Promise<ProviderResult<unknown>> =>
  callProvider(instruction.deadline_ms, (signal) => current().provider.observe(instruction, material, handle, { signal })), { name: "oakridgeObserve" });
const stopStep = DBOS.registerStep(async (instruction: EffectInstruction, handle: ExternalHandle | null): Promise<ProviderResult<unknown>> =>
  callProvider(instruction.deadline_ms, (signal) => current().provider.stop(instruction, handle, { signal })), { name: "oakridgeStop" });

/** An agent attempt's task, rendered once from its pinned prompts and the state it opened on; or why it cannot be. */
type PreparedSession = { readonly kind: "prepared"; readonly material: SessionMaterial } | { readonly kind: "invalid"; readonly detail: string };
const prepareSessionStep = DBOS.registerStep(async (instruction: EffectInstruction): Promise<PreparedSession> => {
  const { db } = current();
  const worker = instruction.worker;
  if (worker.kind !== "agent") return { kind: "invalid", detail: "only an agent attempt has a session task" };
  const texts = await readPromptTexts(db, [worker.prompt.digest, ...(worker.handoff ? [worker.handoff.digest] : [])]);
  const prompt_text = texts.get(worker.prompt.digest);
  if (prompt_text === undefined) return { kind: "invalid", detail: `prompt ${worker.prompt.path} has no pinned text` };
  const handoff_text = worker.handoff ? texts.get(worker.handoff.digest) ?? null : null;
  if (worker.handoff && handoff_text === null) return { kind: "invalid", detail: `prompt ${worker.handoff.path} has no pinned text` };
  const history = await readSessionHistory(db, { run_id: instruction.run_id, unit_id: instruction.action.unit, worker: instruction.action.worker,
    attempt: instruction.attempt, artifacts: worker.creates.map((artifact) => artifact.key) });
  if (!history) return { kind: "invalid", detail: `attempt ${instruction.attempt.action_id}#${instruction.attempt.seq} is not recorded` };
  const context = selectSessionTaskContext(instruction, history, { prompt_text, handoff_text });
  return { kind: "prepared", material: { task: renderSessionTask(instruction, context) } };
}, { name: "oakridgePrepareSession", retriesAllowed: true, maxAttempts: 5 });

const operationStep = DBOS.registerStep(async (instruction: EffectInstruction): Promise<OperationOutcome> => {
  if (instruction.worker.kind !== "code") return { kind: "failed", code: PROVIDER_ERROR_CODES.invalid_instruction, detail: "not a code attempt" };
  const call = { operation: instruction.worker.operation, inputs: instruction.inputs };
  const outcome = await callProvider(instruction.deadline_ms, async (signal) =>
    ({ kind: "acknowledged", value: await current().operations.run(call, { signal }) }));
  return outcome.kind === "acknowledged" ? outcome.value : { kind: "unavailable", detail: outcome.detail };
}, { name: "oakridgeRunOperation" });
/** The artifact's latest revision, resolved once so a re-sent `published` report is the same event (R2). */
const latestRevisionStep = DBOS.registerStep(async (input: { readonly run_id: string; readonly unit_id: string; readonly artifact: string }): Promise<string | null> =>
  readLatestRevisionId(current().db, input), { name: "oakridgeLatestRevision", retriesAllowed: true, maxAttempts: 5 });
const latestAttemptStep = DBOS.registerStep(async (action_id: string): Promise<LatestAttempt | null> =>
  readLatestAttempt(current().db, action_id), { name: "oakridgeLatestAttempt", retriesAllowed: true, maxAttempts: 5 });

const markAcknowledgedStep = DBOS.registerStep(async (intent_id: string): Promise<EffectStatus | null> => markAcknowledged(current().db, intent_id),
  { name: "oakridgeMarkAcknowledged", retriesAllowed: true, maxAttempts: 5 });
interface SettleInput { readonly intent_id: string; readonly status: SettledStatus; readonly last_error: string | null }
const settleStep = DBOS.registerStep(async (input: SettleInput): Promise<EffectStatus | null> => settleIntent(current().db, input),
  { name: "oakridgeSettleIntent", retriesAllowed: true, maxAttempts: 5 });
interface AbandonInput { readonly intent_id: string; readonly last_error: string }
const abandonStep = DBOS.registerStep(async (input: AbandonInput): Promise<EffectStatus | null> => abandonIntent(current().db, input),
  { name: "oakridgeAbandonIntent", retriesAllowed: true, maxAttempts: 5 });
interface TryFailureInput { readonly intent_id: string; readonly last_error: string; readonly retry_in_seconds: number }
const recordTryFailureStep = DBOS.registerStep(async (input: TryFailureInput): Promise<EffectStatus | null> =>
  recordTryFailure(current().db, { intent_id: input.intent_id, last_error: input.last_error, next_try_at: new Date(Date.now() + input.retry_in_seconds * 1000) }),
{ name: "oakridgeRecordTryFailure", retriesAllowed: true, maxAttempts: 5 });

/** One executor report, keyed by attempt so a replayed step is a replayed ingress. */
type ReportInput = ExecutorReport;
type AttemptKey = EffectInstruction["attempt"];
const reportStep = DBOS.registerStep(async (input: ReportInput): Promise<string | null> => {
  const { db, core } = current();
  const committed = await reportWorker({ db, core, wake: () => undefined }, input);
  if (!committed.ok) throw new Error(`${committed.error.operation}: ${committed.error.detail}`);
  const outcome = committed.value;
  if (outcome.kind === "committed") return null;
  if (outcome.kind === "replayed") return outcome.receipt.kind === "committed" ? null : `rejected: ${outcome.receipt.reason}`;
  return `${outcome.kind}: ${"reason" in outcome ? outcome.reason : outcome.detail}`;
}, { name: "oakridgeReportWorker", retriesAllowed: true, maxAttempts: 5 });

/** Report to commit; a refusal is returned (and logged), never thrown: step decides what an event means. */
async function report(input: ReportInput): Promise<string | null> {
  const refused = await reportStep(input);
  if (refused) DBOS.logger.warn(`attempt ${input.attempt.action_id}#${input.attempt.seq}: ${input.report.kind} report not applied: ${refused}`);
  return refused;
}
const failureText = (result: WorkerResult): string | null => result.kind === "failed" ? `${result.code}: ${result.detail}` : null;
/** The attempt failed and no execution exists (the provider definitely refused it): report it and settle the intent. */
async function failAttempt(intent: CarriedIntent, failure: WorkerFailure): Promise<EffectStatus | null> {
  await report({ run_id: intent.run_id, attempt: intent.instruction.attempt, report: { kind: "ended", result: failure } });
  return settleStep({ intent_id: intent.id, status: "failed", last_error: failureText(failure) });
}
/**
 * The attempt failed but an execution may still exist: a session that can no
 * longer be observed, or a start whose answer never came. Report it, then hand
 * the intent to the cleanup carrier, which settles it only on a confirmed stop.
 */
async function abandonAttempt(intent: CarriedIntent, failure: WorkerFailure): Promise<EffectStatus | null> {
  await report({ run_id: intent.run_id, attempt: intent.instruction.attempt, report: { kind: "ended", result: failure } });
  return abandonStep({ intent_id: intent.id, last_error: `${failure.code}: ${failure.detail}` });
}

interface RunAdvance { readonly is_terminal: boolean; readonly pending_starts: readonly string[]; readonly pending_stops: readonly string[] }
/** One recheck of a run: the intents that still need a carrier, and whether the run is done. */
const advanceRunStep = DBOS.registerStep(async (run_id: string): Promise<RunAdvance> => {
  const { db } = current();
  const [standing, intents] = await Promise.all([readRunStanding(db, run_id), listOwedIntents(db, run_id)]);
  const status = standing?.status.kind;
  return { is_terminal: status === undefined || status === "done" || status === "cancelled",
    pending_starts: intents.filter((intent) => intent.status !== "stop_requested").map((intent) => intent.id),
    pending_stops: intents.filter((intent) => intent.status === "stop_requested").map((intent) => intent.id) };
}, { name: "oakridgeAdvanceRun", retriesAllowed: true, maxAttempts: 5 });

// ------------------------------------------------------------ workflows -----

/**
 * An intent workflow must never end in ERROR: a database outage that outlasts a
 * step's own retries is slept through, durably, and the body runs again from
 * the authority row. Parking (DBOS cancel) is the one way out, and it rethrows.
 */
async function untilSettled<Value>(label: string, body: () => Promise<Value>): Promise<Value> {
  for (;;) {
    try { return await body(); }
    catch (error) {
      if (isWorkflowCancellation(error)) throw error;
      const timing = current().timing;
      DBOS.logger.error(`${label}: failed, retrying in ${timing.retry_cap_seconds}s: ${String(error)}`);
      await DBOS.sleepSeconds(timing.retry_cap_seconds);
    }
  }
}

/** Carries one intent: an agent's session, or a code worker's operation. Workflow id = `intentWorkflowId(intent_id)`, then its successors'. */
export const effectWorkflow = DBOS.registerWorkflow((intent_id: string) => untilSettled(`effect ${intent_id}`, () => carryStart(intent_id)), { name: EFFECT_WORKFLOW_NAME });

/**
 * A carrier that has looped `carrier_max_iterations` times hands its intent to
 * the next generation, as the run workflow does at RUN_MAX_ITERATIONS, so no
 * carrier's step history grows for as long as its session or watch lives. The
 * successor resumes from the authority rows. False when this workflow is not
 * one of the intent's generations (an operator's recovery fork): it keeps looping.
 */
async function rollOver(kind: CarrierKind, intent_id: string, carried: CarriedStop = { reason: null }): Promise<boolean> {
  const generation = generationOf(carrierWorkflowId(kind, intent_id), DBOS.workflowID ?? "");
  if (generation === null) return false;
  const workflowID = carrierWorkflowId(kind, intent_id, generation + 1);
  // A successor inherits this carrier's deadline: DBOS propagates it to a workflow started without its own timeout.
  if (kind === "start") await DBOS.startWorkflow(effectWorkflow, { workflowID })(intent_id);
  else await DBOS.startWorkflow(cleanupWorkflow, { workflowID })(intent_id, carried);
  return true;
}
async function carryStart(intent_id: string): Promise<EffectStatus | null> {
  const loaded = await loadIntentStep(intent_id);
  if (loaded.kind === "missing") return null;
  if (loaded.kind === "invalid") {
    // An instruction the executor cannot read fails its attempt; it is never guessed at.
    const failure = { kind: "failed", code: PROVIDER_ERROR_CODES.invalid_instruction, detail: loaded.detail } as const;
    await report({ run_id: loaded.run_id, attempt: loaded.attempt, report: { kind: "ended", result: failure } });
    const settled = await settleStep({ intent_id, status: "failed", last_error: loaded.detail });
    await wakeRun(loaded.run_id);
    return settled;
  }
  const intent = loaded.intent;
  const status = intent.instruction.worker.kind === "code" ? await carryCode(intent) : await carryAgent(intent);
  await wakeRun(intent.run_id);
  return status;
}

/**
 * An agent attempt: claim a start, ensure its kbbl session, report
 * WorkerStarted with the session and its secret's hash, then observe. The
 * first observation delivers the task, after WorkerStarted is committed, so
 * the agent's first publish already has a running attempt to speak for.
 */
async function carryAgent(intent: CarriedIntent): Promise<EffectStatus | null> {
  const timing = current().timing;
  const intent_id = intent.id;
  let status: EffectStatus | null = intent.status;
  if (status !== "pending" && status !== "acknowledged") return status;
  const prepared = await prepareSessionStep(intent.instruction);
  if (prepared.kind === "invalid")
    return failAttempt(intent, { kind: "failed", code: PROVIDER_ERROR_CODES.invalid_instruction, detail: prepared.detail });
  const material = prepared.material;
  let handle = intent.handle;
  // WorkerStarted commits the session before the intent is acknowledged; a
  // carrier re-run between the two resumes that session rather than starting another.
  if (status === "pending" && handle !== null) status = await markAcknowledgedStep(intent_id);
  for (let attempt = 0; status === "pending"; attempt++) {
    const claim = await claimStartStep(intent);
    if (claim.kind === "missing") return null;
    if (claim.kind === "not_pending") { status = claim.status; break; }
    if (claim.kind === "exhausted") {
      // Every try got no definite answer, so a start may have landed.
      return abandonAttempt(intent, { kind: "failed", code: PROVIDER_ERROR_CODES.start_attempts_exhausted,
        detail: `start attempts exhausted (${claim.tries})` });
    }
    const outcome = resolveStart(await startStep(intent.instruction));
    if (outcome.kind === "refused") return failAttempt(intent, outcome.failure);
    if (outcome.kind === "retry") {
      const retry_in = backoff(attempt, timing);
      status = await recordTryFailureStep({ intent_id, last_error: outcome.detail, retry_in_seconds: retry_in });
      if (status === "pending") await DBOS.sleepSeconds(retry_in);
      continue;
    }
    handle = outcome.started.handle;
    await report({ run_id: intent.run_id, attempt: intent.instruction.attempt,
      report: { kind: "started", session_id: handle.session_id, publication_secret_hash: outcome.started.publication_secret_hash } });
    status = await markAcknowledgedStep(intent_id);
  }
  // Acknowledged with no session recorded: the start's report was refused, so nothing can be observed.
  // The stop's ensure finds the session if one was opened.
  if (status === "acknowledged" && handle === null) return abandonAttempt(intent, { kind: "failed", code: PROVIDER_ERROR_CODES.session_unrecorded,
    detail: `attempt ${intent.instruction.attempt.action_id}#${intent.instruction.attempt.seq} has no recorded session to observe` });
  for (let observations = 0, unavailable = 0; status === "acknowledged" && handle !== null; observations++) {
    // A run of unanswered observations is counted in one carrier, so it rolls over only between runs.
    if (observations >= timing.carrier_max_iterations && unavailable === 0 && await rollOver("start", intent_id)) return status;
    const outcome = resolveObserve(await observeStep(intent.instruction, material, handle));
    if (outcome.kind === "ended") {
      await report({ run_id: intent.run_id, attempt: intent.instruction.attempt, report: { kind: "ended", result: outcome.result } });
      return settleStep({ intent_id, status: outcome.result.kind === "succeeded" ? "stopped" : "failed", last_error: failureText(outcome.result) });
    }
    if (outcome.kind === "refused") return abandonAttempt(intent, outcome.failure);
    // Any observation without an answer counts toward the bound, an unreachable kbbl as much as a 5xx; only an answer resets it.
    unavailable = outcome.kind === "retry" ? unavailable + 1 : 0;
    if (unavailable >= Math.max(1, timing.max_observe_unavailable_attempts)) {
      return abandonAttempt(intent, { kind: "failed", code: "observation_unavailable",
        detail: `observation unavailable after ${unavailable} consecutive attempts${outcome.kind === "retry" ? `: ${outcome.detail}` : ""}` });
    }
    await DBOS.sleepSeconds(timing.observe_interval_seconds);
    const reloaded = await loadIntentStep(intent_id);
    // A requested stop ends observation; the cleanup carrier owns the session now.
    status = reloaded.kind === "carried" ? reloaded.intent.status : null;
  }
  return status;
}

/** One run of a code operation, transient failures retried within the start budget: the attempt's result and output. */
type OperationResult = Exclude<OperationOutcome, { readonly kind: "unavailable" }>;
async function runOperation(intent: CarriedIntent): Promise<OperationResult> {
  const timing = current().timing;
  for (let attempt = 1; ; attempt++) {
    const outcome = await operationStep(intent.instruction);
    if (outcome.kind !== "unavailable") return outcome;
    if (attempt >= intent.instruction.max_start_attempts) return { kind: "failed", code: PROVIDER_ERROR_CODES.operation_unavailable,
      detail: `operation unavailable after ${attempt} tries: ${outcome.detail}` };
    await DBOS.sleepSeconds(backoff(attempt - 1, timing));
  }
}

/**
 * A code worker (part 1 §7.2): report WorkerStarted, run the operation,
 * publish its value as the revision of the worker's artifact by the action,
 * report WorkerEnded. A watch (`every`) repeats while the intent is live, each
 * run a later attempt of the same action; step leaves an unchanged value
 * unpublished, and a watch replaced by new inputs is stopped by commit. A stop
 * needs nothing outside: the loop ends when it sees one.
 */
async function carryCode(intent: CarriedIntent): Promise<EffectStatus | null> {
  const worker = intent.instruction.worker;
  if (worker.kind !== "code") return null;
  if (intent.status !== "pending" && intent.status !== "acknowledged") return intent.status;
  const interval = worker.every === null ? null : selectEverySeconds(worker.every);
  if (worker.every !== null && interval === null)
    return failAttempt(intent, { kind: "failed", code: PROVIDER_ERROR_CODES.invalid_instruction, detail: `every ${worker.every} is not a duration` });
  // Resume where the action's attempts stand: another engine version may have run some of them.
  const latest = await latestAttemptStep(intent.instruction.attempt.action_id);
  let seq = latest?.seq ?? intent.instruction.attempt.seq;
  if (latest && latest.status.kind !== "pending" && latest.status.kind !== "running") {
    if (interval === null || latest.status.kind === "failed")
      return settleStep({ intent_id: intent.id, status: latest.status.kind === "failed" ? "failed" : "stopped",
        last_error: latest.status.kind === "failed" ? `${latest.status.code}: ${latest.status.detail}` : null });
    seq += 1;
  }
  let status: EffectStatus | null = intent.status;
  for (let runs = 0; ; runs++) {
    if (runs >= current().timing.carrier_max_iterations && await rollOver("start", intent.id)) return status;
    const attempt = { action_id: intent.instruction.attempt.action_id, seq };
    const refused_start = await report({ run_id: intent.run_id, attempt, report: { kind: "started", session_id: null, publication_secret_hash: null } });
    if (refused_start) {
      // A watch replaced while it slept is refused its next start; the stop commit requested settles it.
      const reloaded = await loadIntentStep(intent.id);
      if (reloaded.kind === "carried" && reloaded.intent.status === "stop_requested") return reloaded.intent.status;
      return settleStep({ intent_id: intent.id, status: "failed", last_error: `start refused: ${refused_start}` });
    }
    if (status === "pending") status = await markAcknowledgedStep(intent.id);
    const outcome = await runOperation(intent);
    let result: WorkerResult = outcome.kind === "succeeded" ? { kind: "succeeded" } : { kind: "failed", code: outcome.code, detail: outcome.detail };
    if (outcome.kind === "succeeded") {
      const location = { run_id: intent.run_id, unit_id: intent.instruction.action.unit, artifact: worker.artifact };
      const predecessor = await latestRevisionStep(location);
      const refused = await report({ run_id: intent.run_id, attempt,
        report: { kind: "published", unit: location.unit_id, artifact: worker.artifact, body: outcome.body, predecessor } });
      if (refused) result = { kind: "failed", code: PROVIDER_ERROR_CODES.output_rejected, detail: refused };
    }
    await report({ run_id: intent.run_id, attempt, report: { kind: "ended", result } });
    // Step may have failed the attempt itself (a validator refusing the output): its record decides.
    const ended = await latestAttemptStep(attempt.action_id);
    const failure = ended?.seq === seq && ended.status.kind === "failed" ? ended.status : result.kind === "failed" ? result : null;
    if (failure !== null || interval === null)
      return settleStep({ intent_id: intent.id, status: failure ? "failed" : "stopped", last_error: failure ? `${failure.code}: ${failure.detail}` : null });
    await DBOS.sleepSeconds(interval);
    const reloaded = await loadIntentStep(intent.id);
    status = reloaded.kind === "carried" ? reloaded.intent.status : null;
    if (status !== "acknowledged") return status;
    seq += 1;
  }
}

/** Carries one requested stop until the provider positively acknowledges it. Workflow id = `cleanupWorkflowId(intent_id)`, then its successors'. */
export const cleanupWorkflow = DBOS.registerWorkflow((intent_id: string, carried?: CarriedStop) =>
  untilSettled(`cleanup ${intent_id}`, () => carryStop(intent_id, carried)), { name: CLEANUP_WORKFLOW_NAME });
/** What a rolled-over stop carrier hands its successor: the reason it loaded, before its own stop tries overwrote `last_error`. */
interface CarriedStop { readonly reason: string | null }
async function carryStop(intent_id: string, carried?: CarriedStop): Promise<EffectStatus | null> {
  const timing = current().timing;
  const loaded = await loadIntentStep(intent_id);
  if (loaded.kind !== "carried") return loaded.kind === "invalid" ? settleStep({ intent_id, status: "stopped", last_error: loaded.detail }) : null;
  const intent = loaded.intent;
  if (intent.status !== "stop_requested") return intent.status;
  // Why the attempt failed, when the executor requested the stop; kept past the stop's own retries, across generations.
  const reason = carried === undefined ? intent.last_error : carried.reason;
  // A code operation leaves nothing running outside: its loop ends when it sees the stop.
  if (intent.instruction.worker.kind === "code") return settleStep({ intent_id, status: "stopped", last_error: reason });
  // A start never claimed never reached kbbl, so nothing can be running; ensuring the session only to close it would spawn the agent.
  if (intent.tries === 0 && intent.handle === null) return confirmStop(intent, reason);
  let handle = intent.handle;
  for (let attempt = 0; ; attempt++) {
    if (attempt >= timing.carrier_max_iterations && await rollOver("stop", intent_id, { reason })) return intent.status;
    const outcome = resolveStop(await stopStep(intent.instruction, handle));
    if (outcome.kind === "confirmed") return confirmStop(intent, reason);
    const retry_in = backoff(attempt, timing);
    if (await recordTryFailureStep({ intent_id, last_error: outcome.detail, retry_in_seconds: retry_in }) !== "stop_requested") return null;
    await DBOS.sleepSeconds(retry_in);
    // The start may have reported its session after this stop was requested.
    const refreshed = await loadIntentStep(intent_id);
    if (refreshed.kind === "carried") handle = refreshed.intent.handle ?? handle;
  }
}
/**
 * Nothing of the attempt runs any more. A stop commit requested (its unit is no
 * longer active, or its watch was replaced) ends an attempt nothing else will;
 * one the executor requested has already reported how its attempt ended.
 */
async function confirmStop(intent: CarriedIntent, reason: string | null): Promise<EffectStatus | null> {
  if (intent.stop_origin === "commit") await report({ run_id: intent.run_id, attempt: intent.instruction.attempt, report: { kind: "ended",
    result: { kind: "failed", code: PROVIDER_ERROR_CODES.attempt_stopped, detail: "stopped because its unit is no longer active" } } });
  const settled = await settleStep({ intent_id: intent.id, status: "stopped", last_error: reason });
  await wakeRun(intent.run_id);
  return settled;
}

export function forkStartStep(steps: readonly { readonly functionID: number; readonly error: Error | null }[]): number {
  const failed = steps.filter((step) => step.error !== null).map((step) => step.functionID);
  if (failed.length) return Math.min(...failed);
  return steps.reduce((last, step) => Math.max(last, step.functionID), 0);
}

export interface RunRecoveryFork {
  readonly workflow_id: string;
  readonly successor_id: string;
  readonly start_step: number;
  readonly application_version: string;
}
/** Reconcile the DBOS side of a handover that may have happened before a crash. */
export async function ensureRunRecoveryFork(input: RunRecoveryFork): Promise<void> {
  const existing = await DBOS.getWorkflowStatus(input.successor_id);
  if (existing) {
    if (existing.forkedFrom !== input.workflow_id)
      throw new Error(`recovery successor ${input.successor_id} is not a fork of ${input.workflow_id}`);
    if (existing.status === "CANCELLED") await DBOS.resumeWorkflow(input.successor_id);
    return;
  }
  try {
    await DBOS.forkWorkflow(input.workflow_id, input.start_step,
      { newWorkflowID: input.successor_id, applicationVersion: input.application_version });
  } catch (error) {
    // Another recovery caller may have inserted the same successor after our read.
    const concurrent = await DBOS.getWorkflowStatus(input.successor_id);
    if (concurrent?.forkedFrom !== input.workflow_id) throw error;
    if (concurrent.status === "CANCELLED") await DBOS.resumeWorkflow(input.successor_id);
  }
}

async function recoverErroredRun(run_id: string, generation: number): Promise<void> {
  const id = runWorkflowId(run_id, generation);
  const steps = await DBOS.listWorkflowSteps(id) ?? [];
  await ensureRunRecoveryFork({ workflow_id: id, successor_id: runWorkflowId(run_id, generation + 1),
    start_step: forkStartStep(steps), application_version: DBOS.applicationVersion });
}

const isStartOwed = (status: EffectStatus): boolean => status === "pending" || status === "acknowledged";
/**
 * End an owed start that no carrier will finish. An unclaimed intent never
 * reached the provider and fails outright; any other may have a live
 * execution, so its stop is requested and the cleanup carrier confirms it.
 */
async function endOwedStart(intent: CarriedIntent, failure: WorkerFailure): Promise<void> {
  if (intent.status === "pending" && intent.tries === 0) await failAttempt(intent, failure);
  else await abandonAttempt(intent, failure);
  DBOS.logger.error(`effect ${intent.id}: ${failure.code}: ${failure.detail}`);
}
async function settleExpiredEffect(intent_id: string): Promise<void> {
  const loaded = await loadIntentStep(intent_id);
  if (loaded.kind !== "carried" || !isStartOwed(loaded.intent.status)) return;
  await endOwedStart(loaded.intent, { kind: "failed", code: "execution_deadline_exceeded", detail: `execution deadline exceeded for ${intent_id}` });
}

const effectExpiredStep = DBOS.registerStep(async (deadline_epoch_ms: number): Promise<boolean> =>
  deadline_epoch_ms <= Date.now(), { name: "oakridgeEffectExpired" });

export async function dispatchChild(run_id: string, intent_id: string, kind: CarrierKind): Promise<void> {
  const carrier = await currentCarrier(kind, intent_id);
  if (!carrier) {
    const deadline_ms = current().timing.execution_deadline_ms;
    if (kind === "start") await DBOS.startWorkflow(effectWorkflow,
      { workflowID: carrierWorkflowId(kind, intent_id), ...(deadline_ms === null ? {} : { timeoutMS: deadline_ms }) })(intent_id);
    else await DBOS.startWorkflow(cleanupWorkflow, { workflowID: carrierWorkflowId(kind, intent_id) })(intent_id);
    return;
  }
  const { generation, status } = carrier;
  if (status.status === "PENDING" || status.status === "ENQUEUED") return;
  if (status.status === "CANCELLED") {
    if (kind === "start" && status.deadlineEpochMS !== undefined && await effectExpiredStep(status.deadlineEpochMS)) {
      await settleExpiredEffect(intent_id);
      return;
    }
    await DBOS.resumeWorkflow(status.workflowID);
    return;
  }
  // The carrier finished while its intent is still owed, so nothing will carry it. A start
  // is ended as a failed attempt the operator can retry, rather than carried again by a body
  // that may finish the same way; a stop must be confirmed, so the next generation carries it.
  const loaded = await loadIntentStep(intent_id);
  if (loaded.kind !== "carried") return;
  const intent = loaded.intent;
  const detail = `run ${run_id}: ${kind} carrier ${status.workflowID} is ${status.status} while intent ${intent_id} is ${intent.status}`;
  if (kind === "start" && isStartOwed(intent.status)) {
    await endOwedStart(intent, { kind: "failed", code: PROVIDER_ERROR_CODES.carrier_ended, detail });
    return;
  }
  if (kind === "stop" && intent.status === "stop_requested") {
    DBOS.logger.error(`${detail}; carrying it again`);
    await DBOS.startWorkflow(cleanupWorkflow, { workflowID: carrierWorkflowId(kind, intent_id, generation + 1) })(intent_id);
  }
}

export const runWorkflow = DBOS.registerWorkflow(async (run_id: string): Promise<void> => {
  const timing = current().timing;
  let boundary_failures = 0;
  for (let iteration = 0; iteration < RUN_MAX_ITERATIONS; iteration++) {
    let advance: RunAdvance;
    try { advance = await advanceRunStep(run_id); boundary_failures = 0; }
    catch (error) {
      if (isWorkflowCancellation(error)) throw error;
      const failure = new RunInfrastructureError(run_id, "advance", String(error));
      DBOS.logger.error(failure.message);
      if (++boundary_failures >= RUN_BOUNDARY_RETRIES) throw failure;
      await DBOS.sleepSeconds(timing.retry_cap_seconds);
      continue;
    }
    // DBOS statuses and authority intents are durable; no local dispatch set survives a restart.
    try {
      for (const id of advance.pending_starts) await dispatchChild(run_id, id, "start");
      for (const id of advance.pending_stops) await dispatchChild(run_id, id, "stop");
    } catch (error) {
      if (isWorkflowCancellation(error)) throw error;
      const failure = error instanceof RunInfrastructureError ? error : new RunInfrastructureError(run_id, "dispatch", String(error));
      DBOS.logger.error(failure.message);
      throw failure;
    }
    if (advance.is_terminal && advance.pending_starts.length === 0 && advance.pending_stops.length === 0) return;
    try { await DBOS.recv(RUN_WAKE_TOPIC, { timeoutSeconds: timing.wake_timeout_seconds }); }
    catch (error) {
      if (isWorkflowCancellation(error)) throw error;
      throw new RunInfrastructureError(run_id, "wait for wake", String(error));
    }
  }
  const generation = runGenerationOf(run_id, DBOS.workflowID ?? "");
  if (generation === null) throw new RunInfrastructureError(run_id, "rollover", `workflow ${DBOS.workflowID} is not a run workflow`);
  await DBOS.startWorkflow(runWorkflow, { workflowID: runWorkflowId(run_id, generation + 1) })(run_id);
}, { name: RUN_WORKFLOW_NAME });

// ------------------------------------------------------------- entry -------

/** Starts the run workflow unless one is already live (or recovering) for this run. */
export async function ensureRunWorkflow(run_id: string): Promise<void> {
  const generation = await currentRunGeneration(run_id);
  if (generation === null) { await DBOS.startWorkflow(runWorkflow, { workflowID: runWorkflowId(run_id) })(run_id); return; }
  const id = runWorkflowId(run_id, generation);
  const successor = runWorkflowId(run_id, generation + 1);
  const existing = await DBOS.getWorkflowStatus(id);
  if (existing && isFromOtherEngine(existing) && existing.status !== "SUCCESS") {
    // Another engine's workflow never runs here, and replaying its steps under
    // this code would be unsound. Fence it and carry the run from the authority.
    if (existing.status === "PENDING" || existing.status === "ENQUEUED") await DBOS.cancelWorkflow(id);
    await DBOS.startWorkflow(runWorkflow, { workflowID: successor })(run_id);
    return;
  }
  if (existing?.status === "PENDING" || existing?.status === "ENQUEUED") return;
  if (existing?.status === "CANCELLED") { await DBOS.resumeWorkflow(id); return; }
  if (existing?.status === "ERROR") { await recoverErroredRun(run_id, generation); return; }
  if (existing?.status === "SUCCESS" && (await listRunsNeedingWork(current().db, { run_id })).length === 0) return;
  await DBOS.startWorkflow(runWorkflow, { workflowID: existing ? successor : id })(run_id);
}

/** A wake is a hint, never a fact: the run re-reads the authority on receipt. */
export async function wakeRun(run_id: string): Promise<void> {
  try {
    await ensureRunWorkflow(run_id);
    const generation = await currentRunGeneration(run_id);
    if (generation !== null) await DBOS.send(runWorkflowId(run_id, generation), null, RUN_WAKE_TOPIC);
  }
  catch (error) { DBOS.logger.warn(`run ${run_id}: wake not delivered: ${String(error)}`); }
}

const WORKFLOW_NAMES = [RUN_WORKFLOW_NAME, EFFECT_WORKFLOW_NAME, CLEANUP_WORKFLOW_NAME];
function isExpiredEffectWorkflow(status: WorkflowStatus, now_ms: number): boolean {
  return status.workflowName === EFFECT_WORKFLOW_NAME
    && status.deadlineEpochMS !== undefined && status.deadlineEpochMS <= now_ms;
}

function intentOf(status: WorkflowStatus): string | null {
  const intent_id = status.input?.[0];
  return typeof intent_id === "string" ? intent_id : null;
}

/**
 * A live workflow of another engine version is one a crashed or replaced
 * process left behind. Cancelling it fences any process of that version still
 * running; its run and intents are carried again under this version.
 */
export async function fenceOtherEngineWorkflows(): Promise<number> {
  const live = await DBOS.listWorkflows({ status: ["PENDING", "ENQUEUED"], workflowName: WORKFLOW_NAMES });
  const stale = live.filter(isFromOtherEngine);
  if (stale.length) await DBOS.cancelWorkflows(stale.map((status) => status.workflowID));
  return stale.length;
}

/**
 * Boot: workflows this engine parked at its last shutdown resume from their
 * last step, and every run that still needs work gets its workflow back.
 * Another version's workflows are fenced; the run recheck starts this
 * version's carriers for any intent still owed.
 */
export async function resumeActiveRuns(db: Database): Promise<number> {
  await fenceOtherEngineWorkflows();
  const parked = await DBOS.listWorkflows({ status: "CANCELLED", workflowName: WORKFLOW_NAMES.slice(1),
    applicationVersion: DBOS.applicationVersion });
  const now_ms = Date.now();
  const expired = parked.filter((status) => isExpiredEffectWorkflow(status, now_ms));
  const expired_ids = new Set(expired.map((status) => status.workflowID));
  const resumable = parked.filter((status) => !expired_ids.has(status.workflowID));
  if (resumable.length) await DBOS.resumeWorkflows(resumable.map((status) => status.workflowID));
  for (const status of expired) {
    const intent_id = intentOf(status);
    if (intent_id !== null) await settleExpiredEffect(intent_id);
  }
  const runs = await listRunsNeedingWork(db);
  for (const run_id of runs) await ensureRunWorkflow(run_id);
  return runs.length;
}

/**
 * Shutdown: our workflows wait on wakes and observations for as long as a run
 * lives, so a clean stop parks them (DBOS cancel) and the next boot resumes
 * them. Nothing durable changes; the authority rows are untouched.
 */
export async function parkRunningWorkflows(): Promise<number> {
  // Only this version's workflows: another version's live process owns its own.
  const running = await DBOS.listWorkflows({ status: ["PENDING", "ENQUEUED"], workflowName: WORKFLOW_NAMES,
    applicationVersion: DBOS.applicationVersion });
  if (running.length) await DBOS.cancelWorkflows(running.map((status) => status.workflowID));
  return running.length;
}
