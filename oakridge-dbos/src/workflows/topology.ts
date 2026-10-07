import { DBOS, Error as DBOSErrors, type WorkflowStatus } from "@dbos-inc/dbos-sdk";
import type { CoreClient } from "../core-client/client";
import type { CheckedValue } from "../core-client/generated-contracts";
import { recoverConfiguredFailure, recoverSessionFailure, recoverStartFailure } from "../effects/operations/production-provider";
import { PROVIDER_ERROR_CODES } from "../effects/provider-catalog";
import { deliverEvidence, undeliveredEvidence } from "../effects/evidence";
import { readIntent, type EffectIntent, type EffectPayload, type EffectStatus } from "../effects/intents";
import { bounded, exhaustStart, resolveObserve, resolveStart, resolveStop, settleObserveRetry, startAttemptsExhausted, type StartOutcome } from "../effects/outcomes";
import type { EffectProvider, ProviderResult } from "../effects/provider";
import { advanceChildrenPage, type LifecycleFailure } from "../runtime/advance-children";
import { claimStartAttempt, persistEffectResult } from "../storage/effect-results";
import { claimRunGeneration, currentRunAddress, currentRunGeneration } from "../storage/run-lifecycle";
import type { MutationService } from "../storage/mutation-service";
import type { RunId } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";

/**
 * Three generic workflows interpret every pinned bundle. None of them knows a
 * stage, an output or a command: the bundle's decision trees decide, the
 * authority tables record, and these workflows only carry committed intents to
 * providers and committed evidence back. DBOS owns the execution — a crash
 * mid-step resumes at that step on the next process of the same engine version.
 *
 * The services are process-wide and registered by the composition before
 * `DBOS.launch`; a workflow step never receives a connection as an argument.
 */
export interface WorkflowServices {
  readonly db: TransactionalSqlExecutor;
  readonly core: CoreClient;
  readonly mutations: MutationService;
  readonly provider: EffectProvider;
  readonly timing: WorkflowTiming;
}
/** Provider calls carry no timing here: each is bounded by its pinned action's `deadline_ms`. */
export interface WorkflowTiming {
  /** First sleep after a start or stop attempt that must be repeated; doubles up to the cap. */
  readonly retry_initial_seconds: number;
  readonly retry_cap_seconds: number;
  /** Sleep between terminal observations that report a still-running execution. */
  readonly observe_interval_seconds: number;
  /** Maximum consecutive transiently_unavailable observations before rejection. */
  readonly max_observe_unavailable_attempts: number;
  /** Bound on how long a lost wake can delay a run's recheck. */
  readonly wake_timeout_seconds: number;
  /** DBOS timeout for an effect, including observation and retry sleeps. */
  readonly execution_deadline_ms: number;
  /** Number of scopes admitted to one run advance step. */
  readonly child_scan_max_scopes: number;
  /** Per-scope share of the serial child request budget. */
  readonly child_scan_per_scope_deadline_ms: number;
  /** Cap on the serial child request budget within the run advance step. */
  readonly child_scan_max_request_deadline_ms: number;
}
export const DEFAULT_WORKFLOW_TIMING: WorkflowTiming = {
  retry_initial_seconds: 1, retry_cap_seconds: 30, observe_interval_seconds: 5,
  max_observe_unavailable_attempts: 10, wake_timeout_seconds: 30, execution_deadline_ms: 3_600_000,
  child_scan_max_scopes: 2, child_scan_per_scope_deadline_ms: 60_000,
  child_scan_max_request_deadline_ms: 120_000,
};

let services: WorkflowServices | null = null;
export function registerWorkflowServices(value: WorkflowServices): void { services = value; }
function current(): WorkflowServices {
  if (!services) throw new Error("workflow services are not registered");
  return services;
}

export const RUN_WAKE_TOPIC = "oakridge-run-wake";
export const runWorkflowId = (run_id: string, generation = 0): string => generation === 0 ? `run:${run_id}` : `run:${run_id}:${generation}`;
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

// ---------------------------------------------------------------- steps -----
// Every step is one IO boundary. Steps return values, never throw for domain
// reasons; DBOS retries only infrastructure failures (a lost connection).

const loadIntentStep = DBOS.registerStep(async (intent_id: string): Promise<EffectIntent | null> => readIntent(current().db, intent_id),
  { name: "oakridgeLoadIntent", retriesAllowed: true, maxAttempts: 5 });

async function callProvider<Value>(deadline_ms: number, operation: (signal: AbortSignal) => Promise<ProviderResult<Value>>): Promise<ProviderResult<Value>> {
  const controller = new AbortController();
  let call: Promise<ProviderResult<Value>>;
  try { call = operation(controller.signal); } catch (error) { call = Promise.resolve({ kind: "uncertain", detail: String(error) }); }
  return bounded(call, deadline_ms, controller);
}
// Reservation is inside the step's IO body: a re-execution before checkpointing
// must claim another durable attempt, rather than replaying an earlier claim.
export async function performStartAttempt(intent_id: string): Promise<StartOutcome | null> {
  const { db, provider } = current();
  const payload = await claimStartAttempt(db, intent_id);
  if (!payload) {
    const intent = await readIntent(db, intent_id);
    return intent?.status === "pending" && startAttemptsExhausted(intent.payload) ? exhaustStart(intent.payload) : null;
  }
  const result = await callProvider(payload.invocation.selection.definition.deadline_ms,
    (signal) => provider.start(payload.invocation, { signal }));
  return resolveStart(payload, result);
}
const startStep = DBOS.registerStep(performStartAttempt, { name: "oakridgeStart" });
const observeStep = DBOS.registerStep(async (payload: EffectPayload): Promise<ProviderResult<unknown>> =>
  callProvider(payload.invocation.selection.definition.deadline_ms, (signal) => current().provider.observe(payload.invocation, payload.handle, { signal })), { name: "oakridgeObserve" });
const startRejectionStep = DBOS.registerStep(async (payload: EffectPayload): Promise<EffectPayload> => {
  if (payload.evidence) return payload;
  const failure = payload.failure;
  if (!failure || failure.kind === "observation_rejection") throw new Error("start rejection has no structured failure");
  const { db, core } = current();
  const recover = (code: string, detail: string) => recoverConfiguredFailure({ db, core, invocation: payload.invocation, code, detail });
  const recovered = failure.kind === "provider_rejection"
    ? await recoverStartFailure({ db, core, invocation: payload.invocation, code: failure.code, detail: failure.detail })
    : await recover(PROVIDER_ERROR_CODES.start_attempts_exhausted, failure.detail);
  if (recovered.kind !== "permanently_rejected") throw new Error(`start recovery unavailable: ${JSON.stringify(recovered)}`);
  return { ...payload, ...(recovered.evidence ? { evidence: recovered.evidence } : {}) };
}, { name: "oakridgeStartRejection", retriesAllowed: true, maxAttempts: 5 });
const observationRejectionStep = DBOS.registerStep(async (payload: EffectPayload): Promise<EffectPayload> => {
  if (payload.evidence || payload.invocation.request?.kind !== "kbbl_session") return payload;
  const { db, core } = current();
  const recovery = await recoverSessionFailure({ db, core, invocation: payload.invocation,
    detail: payload.failure?.kind === "observation_rejection" ? payload.failure.detail : "observation rejected" });
  if (recovery.kind !== "permanently_rejected") throw new Error(`observation recovery unavailable: ${JSON.stringify(recovery)}`);
  return { ...payload, ...(recovery.evidence ? { evidence: recovery.evidence } : {}) };
}, { name: "oakridgeObservationRejection", retriesAllowed: true, maxAttempts: 5 });

const stopStep = DBOS.registerStep(async (payload: EffectPayload): Promise<ProviderResult<unknown>> =>
  callProvider(payload.invocation.selection.definition.deadline_ms, (signal) => current().provider.stop(payload.invocation, payload.handle, { signal })), { name: "oakridgeStop" });

interface PersistInput { readonly intent_id: string; readonly status: EffectStatus; readonly payload: EffectPayload; readonly terminal_result: CheckedValue | null }
const persistStep = DBOS.registerStep(async (input: PersistInput): Promise<EffectStatus | null> => persistEffectResult(current().db, input),
  { name: "oakridgePersistEffect", retriesAllowed: true, maxAttempts: 5 });

const deliverEvidenceStep = DBOS.registerStep(async (intent_id: string): Promise<string | null> => {
  const { db, mutations } = current();
  const intent = await readIntent(db, intent_id);
  if (!intent) return "intent missing";
  const delivery = await deliverEvidence(db, mutations, intent);
  return delivery.kind === "deferred" ? delivery.detail : null;
}, { name: "oakridgeDeliverEvidence", retriesAllowed: true, maxAttempts: 5 });

export interface RunAdvance {
  readonly is_terminal: boolean;
  readonly next_cursor: string | null;
  readonly pending_starts: readonly string[];
  readonly pending_stops: readonly string[];
  readonly failures: readonly LifecycleFailure[];
}
/**
 * One recheck of a run: deliver configured lifecycle triggers, retry any
 * deferred evidence, and list the intents that still need a workflow. A scope
 * whose trigger is rejected is reported, not thrown — it never blocks the rest.
 */
const advanceRunStep = DBOS.registerStep(async (run_id: RunId, cursor: string | null): Promise<RunAdvance> => {
  const { db, core, mutations } = current();
  const timing = current().timing;
  const page = await advanceChildrenPage({ db, core, mutations, run_ids: [run_id], after_scope_id: cursor,
    max_scopes: timing.child_scan_max_scopes, per_scope_deadline_ms: timing.child_scan_per_scope_deadline_ms,
    max_request_deadline_ms: timing.child_scan_max_request_deadline_ms });
  const failures: LifecycleFailure[] = [...page.failures];
  for (const row of await undeliveredEvidence(db, run_id)) {
    const delivery = await deliverEvidence(db, mutations, row);
    if (delivery.kind === "deferred") failures.push({ scope_id: row.scope_id, detail: `evidence ${row.payload.evidence?.id ?? row.id}: ${delivery.detail}` });
  }
  const intents = await db.query<{ id: string; status: EffectStatus }>(`SELECT e.id,e.status FROM authority.effect_intent e JOIN authority.scope_instance s ON s.id=e.scope_id
    WHERE s.run_id=$1 AND ((e.payload->>'action'='start' AND e.status IN ('pending','acknowledged')) OR e.status='cleanup_pending') ORDER BY e.id`, [run_id]);
  const roots = await db.query<{ is_terminal: boolean }>("SELECT is_terminal FROM authority.scope_instance WHERE run_id=$1 AND parent_id IS NULL", [run_id]);
  return { is_terminal: roots[0]?.is_terminal ?? true, next_cursor: page.next_cursor,
    pending_starts: intents.filter((intent) => intent.status !== "cleanup_pending").map((intent) => intent.id),
    pending_stops: intents.filter((intent) => intent.status === "cleanup_pending").map((intent) => intent.id), failures };
}, { name: "oakridgeAdvanceRun", retriesAllowed: true, maxAttempts: 5, timeoutMS: 180_000 });

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
      if (error instanceof DBOSErrors.DBOSWorkflowCancelledError || error instanceof DBOSErrors.DBOSAwaitedWorkflowCancelledError) throw error;
      const timing = current().timing;
      DBOS.logger.error(`${label}: failed, retrying in ${timing.retry_cap_seconds}s: ${String(error)}`);
      await DBOS.sleepSeconds(timing.retry_cap_seconds);
    }
  }
}

/** Carries one committed start intent to its provider and its terminal result back. Workflow id = intent id. */
export const effectWorkflow = DBOS.registerWorkflow((intent_id: string) => untilSettled(`effect ${intent_id}`, () => carryStart(intent_id)), { name: "oakridgeEffectWorkflow" });
async function carryStart(intent_id: string): Promise<EffectStatus | null> {
  const timing = current().timing;
  let intent = await loadIntentStep(intent_id);
  if (!intent || intent.payload.action !== "start") return intent?.status ?? null;
  let payload = intent.payload;
  let status = intent.status;
  let terminal: CheckedValue | null = null;
  for (let attempt = 0; status === "pending"; attempt++) {
    const outcome = await startStep(intent_id);
    if (!outcome) {
      intent = await loadIntentStep(intent_id);
      if (!intent || intent.status !== "pending") return intent?.status ?? null;
      continue;
    }
    payload = outcome.payload;
    if (outcome.kind === "rejected") payload = await startRejectionStep(payload);
    if (outcome.kind === "retry") {
      const written = await persistStep({ intent_id, status: "pending", payload, terminal_result: null });
      if (written !== "pending") return written;
      await DBOS.sleepSeconds(backoff(attempt, timing));
      intent = await loadIntentStep(intent_id);
      if (!intent) return null;
      status = intent.status;
      payload = { ...intent.payload, ...payload, handle: intent.payload.handle ?? payload.handle };
      continue;
    }
    if (outcome.kind === "completed") terminal = outcome.result;
    const next: EffectStatus = outcome.kind === "acknowledged" ? "acknowledged" : outcome.kind === "completed" ? "cleanup_confirmed" : "rejected";
    const written = await persistStep({ intent_id, status: next, payload, terminal_result: terminal });
    if (written === null) return null;
    status = written;
  }
  while (status === "acknowledged") {
    const outcome = resolveObserve(payload, await observeStep(payload));
    if (outcome.kind === "terminal") {
      payload = outcome.payload;
      terminal = outcome.result;
      const written = await persistStep({ intent_id, status: "cleanup_confirmed", payload, terminal_result: terminal });
      status = written ?? "cleanup_confirmed";
      break;
    }
    if (outcome.kind === "rejected" || outcome.kind === "retry") {
      const settled = outcome.kind === "rejected" ? { status: "rejected" as const, payload: outcome.payload }
        : settleObserveRetry(payload, outcome, timing.max_observe_unavailable_attempts);
      payload = settled.status === "rejected" ? await observationRejectionStep(settled.payload) : settled.payload;
      const next = settled.status;
      const written = await persistStep({ intent_id, status: next, payload, terminal_result: null });
      status = written ?? next;
      if (status !== "acknowledged") break;
    } else {
      payload = { ...payload, observe_unavailable_attempts: 0 };
      await persistStep({ intent_id, status: "acknowledged", payload, terminal_result: null });
    }
    await DBOS.sleepSeconds(timing.observe_interval_seconds);
    intent = await loadIntentStep(intent_id);
    if (!intent) return null;
    status = intent.status; // a revocation ends observation; its stop intent owns cleanup
  }
  if (payload.evidence) {
    const deferred = await deliverEvidenceStep(intent_id);
    if (deferred) DBOS.logger.warn(`effect ${intent_id}: evidence deferred to the run recheck: ${deferred}`);
  }
  await wakeRunOf(intent.scope_id);
  return status;
}

/** Carries one committed stop intent to its provider until the provider positively acknowledges it. Workflow id = intent id. */
export const cleanupWorkflow = DBOS.registerWorkflow((intent_id: string) => untilSettled(`cleanup ${intent_id}`, () => carryStop(intent_id)), { name: "oakridgeCleanupWorkflow" });
async function carryStop(intent_id: string): Promise<EffectStatus | null> {
  const timing = current().timing;
  const intent = await loadIntentStep(intent_id);
  if (!intent || intent.payload.action !== "stop") return intent?.status ?? null;
  let payload = intent.payload;
  for (let attempt = 0; ; attempt++) {
    const outcome = resolveStop(await stopStep(payload));
    if (outcome.kind === "confirmed") {
      const written = await persistStep({ intent_id, status: "cleanup_confirmed", payload, terminal_result: null });
      await wakeRunOf(intent.scope_id);
      return written;
    }
    payload = { ...payload, last_detail: outcome.detail };
    const written = await persistStep({ intent_id, status: "cleanup_pending", payload, terminal_result: null });
    if (written !== "cleanup_pending") return written;
    await DBOS.sleepSeconds(backoff(attempt, timing));
    // The start may have learned its handle after this stop was recorded.
    const refreshed = await loadIntentStep(intent_id);
    if (!refreshed) return null;
    payload = { ...payload, handle: payload.handle ?? refreshed.payload.handle };
  }
}

/**
 * Keeps one run moving: every wake (or timeout) rechecks the authority, starts
 * the workflows for intents that need one, and goes back to waiting. Ends when
 * the root scope is terminal and nothing is owed. Workflow id = `run:<run_id>`.
 */
const rolloverRunStep = DBOS.registerStep(async (run_id: string, workflow_id: string, cursor: string | null): Promise<number> => {
  const db = current().db;
  const generation = await currentRunGeneration(db, run_id);
  if (generation === null) throw new RunInfrastructureError(run_id, "rollover", "authority run missing");
  if (runWorkflowId(run_id, generation) !== workflow_id) return generation;
  const successor = await claimRunGeneration(db, run_id, generation, cursor);
  if (successor === null) throw new RunInfrastructureError(run_id, "rollover", "generation changed concurrently");
  return successor;
}, { name: "oakridgeRolloverRun", retriesAllowed: true, maxAttempts: 5 });
const claimRunGenerationStep = DBOS.registerStep(async (run_id: string, generation: number): Promise<number | null> => {
  const db = current().db;
  const claimed = await claimRunGeneration(db, run_id, generation);
  if (claimed !== null) return claimed;
  const current_generation = await currentRunGeneration(db, run_id);
  return current_generation !== null && current_generation > generation ? current_generation : null;
}, { name: "oakridgeClaimRunGeneration", retriesAllowed: true, maxAttempts: 5 });

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
/** Reconcile the DBOS side of a handover that may have committed before a crash. */
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

async function recoverErroredRun(run_id: string, generation: number): Promise<number> {
  const id = runWorkflowId(run_id, generation);
  const steps = await DBOS.listWorkflowSteps(id) ?? [];
  await ensureRunRecoveryFork({ workflow_id: id, successor_id: runWorkflowId(run_id, generation + 1),
    start_step: forkStartStep(steps), application_version: DBOS.applicationVersion });
  const successor = await claimRunGenerationStep(run_id, generation);
  if (successor === null)
    throw new RunInfrastructureError(run_id, "recover", "generation changed during fork");
  return successor;
}

async function settleExpiredEffect(intent_id: string): Promise<void> {
  const intent = await loadIntentStep(intent_id);
  if (!intent || (intent.status !== "pending" && intent.status !== "acknowledged")) return;
  const payload = await startRejectionStep({ ...intent.payload,
    failure: { kind: "attempt_budget_exhausted", detail: `execution deadline exceeded for ${intent_id}` } });
  await persistStep({ intent_id, status: "rejected", payload, terminal_result: null });
  await deliverEvidenceStep(intent_id);
  DBOS.logger.error(`effect ${intent_id}: execution deadline exceeded`);
}

export async function dispatchChild(run_id: string, intent_id: string, kind: "start" | "stop"): Promise<void> {
  const status = await DBOS.getWorkflowStatus(intent_id);
  if (!status) {
    if (kind === "start") await DBOS.startWorkflow(effectWorkflow,
      { workflowID: intent_id, timeoutMS: current().timing.execution_deadline_ms })(intent_id);
    else await DBOS.startWorkflow(cleanupWorkflow, { workflowID: intent_id })(intent_id);
    return;
  }
  if (status.status === "PENDING" || status.status === "ENQUEUED") return;
  if (status.status === "CANCELLED") {
    if (kind === "start" && status.deadlineEpochMS !== undefined && status.deadlineEpochMS <= Date.now()) {
      await settleExpiredEffect(intent_id);
      return;
    }
    await DBOS.resumeWorkflow(intent_id);
    return;
  }
  if (status.status === "ERROR" || status.status === "SUCCESS")
    throw new RunInfrastructureError(run_id, `dispatch ${kind} ${intent_id}`, `workflow ${status.status} while intent remains pending`);
}

export const runWorkflow = DBOS.registerWorkflow(async (run_id: string, initial_cursor: string | null = null): Promise<void> => {
  const timing = current().timing;
  let boundary_failures = 0;
  let cursor = initial_cursor;
  for (let iteration = 0; iteration < RUN_MAX_ITERATIONS; iteration++) {
    let advance: RunAdvance;
    try { advance = await advanceRunStep(run_id as RunId, cursor); boundary_failures = 0; }
    catch (error) {
      if (isWorkflowCancellation(error)) throw error;
      const failure = new RunInfrastructureError(run_id, "advance", String(error));
      DBOS.logger.error(failure.message);
      if (++boundary_failures >= RUN_BOUNDARY_RETRIES) throw failure;
      await DBOS.sleepSeconds(timing.retry_cap_seconds);
      continue;
    }
    for (const failure of advance.failures) DBOS.logger.warn(`run ${run_id}: scope ${failure.scope_id}: ${failure.detail}`);
    // DBOS statuses and authority intents are durable; no local dispatch set survives a restart.
    try {
      for (const id of advance.pending_starts) await dispatchChild(run_id, id, "start");
      for (const id of advance.pending_stops) await dispatchChild(run_id, id, "stop");
    } catch (error) {
      if (isWorkflowCancellation(error)) throw error;
      const failure = error instanceof RunInfrastructureError ? error
        : new RunInfrastructureError(run_id, "dispatch", String(error));
      DBOS.logger.error(failure.message);
      throw failure;
    }
    if (advance.is_terminal && advance.pending_starts.length === 0 && advance.pending_stops.length === 0) return;
    cursor = advance.next_cursor;
    if (cursor === null) {
      try { await DBOS.recv(RUN_WAKE_TOPIC, { timeoutSeconds: timing.wake_timeout_seconds }); }
      catch (error) {
        if (isWorkflowCancellation(error)) throw error;
        throw new RunInfrastructureError(run_id, "wait for wake", String(error));
      }
    }
  }
  const successor = await rolloverRunStep(run_id, DBOS.workflowID ?? "", cursor);
  await DBOS.startWorkflow(runWorkflow, { workflowID: runWorkflowId(run_id, successor) })(run_id, cursor);
}, { name: "oakridgeRunWorkflow" });

// ------------------------------------------------------------- entry -------

/** Starts the run workflow unless one is already live (or recovering) for this run. */
export async function ensureRunWorkflow(run_id: string): Promise<void> {
  const db = current().db;
  const address = await currentRunAddress(db, run_id);
  if (address === null) return;
  const { generation } = address;
  const id = runWorkflowId(run_id, generation);
  const existing = await DBOS.getWorkflowStatus(id);
  if (existing?.status === "PENDING" || existing?.status === "ENQUEUED") return;
  if (existing?.status === "CANCELLED") { await DBOS.resumeWorkflow(id); return; }
  if (existing?.status === "ERROR") {
    await recoverErroredRun(run_id, generation);
    return;
  }
  if (existing?.status === "SUCCESS") {
    const successor = await claimRunGeneration(db, run_id, generation);
    if (successor === null) throw new RunInfrastructureError(run_id, "restart", "generation changed concurrently");
    await DBOS.startWorkflow(runWorkflow, { workflowID: runWorkflowId(run_id, successor) })(run_id, address.cursor);
    return;
  }
  await DBOS.startWorkflow(runWorkflow, { workflowID: id })(run_id, address.cursor);
}

/** A wake is a hint, never a fact: the run re-reads the authority on receipt. */
export async function wakeRun(run_id: string): Promise<void> {
  try {
    await ensureRunWorkflow(run_id);
    const generation = await currentRunGeneration(current().db, run_id);
    if (generation !== null) await DBOS.send(runWorkflowId(run_id, generation), null, RUN_WAKE_TOPIC);
  }
  catch (error) { DBOS.logger.warn(`run ${run_id}: wake not delivered: ${String(error)}`); }
}
export async function wakeRunOf(scope_id: string): Promise<void> {
  const address = await runOfScopeStep(scope_id);
  if (!address) return;
  let generation = Number(address.current_generation);
  const status = await DBOS.getWorkflowStatus(runWorkflowId(address.run_id, generation));
  if (status?.status === "ERROR") generation = await recoverErroredRun(address.run_id, generation);
  await DBOS.send(runWorkflowId(address.run_id, generation), null, RUN_WAKE_TOPIC);
}
interface RunAddress { readonly run_id: string; readonly current_generation: string | number }
const runOfScopeStep = DBOS.registerStep(async (scope_id: string): Promise<RunAddress | null> => {
  const rows = await current().db.query<RunAddress>("SELECT s.run_id,r.current_generation FROM authority.scope_instance s JOIN authority.run r ON r.id=s.run_id WHERE s.id=$1", [scope_id]);
  return rows[0] ?? null;
}, { name: "oakridgeRunOfScope", retriesAllowed: true, maxAttempts: 5 });

const WORKFLOW_NAMES = ["oakridgeRunWorkflow", "oakridgeEffectWorkflow", "oakridgeCleanupWorkflow"];
function isExpiredEffectWorkflow(status: WorkflowStatus, now_ms: number): boolean {
  return status.workflowName === "oakridgeEffectWorkflow"
    && status.deadlineEpochMS !== undefined && status.deadlineEpochMS <= now_ms;
}

/**
 * Boot: workflows this engine parked at its last shutdown resume from their
 * last step, and every run whose root is still active gets its workflow back.
 */
export async function resumeActiveRuns(db: TransactionalSqlExecutor): Promise<number> {
  const parked = await DBOS.listWorkflows({ status: "CANCELLED", workflowName: WORKFLOW_NAMES.slice(1) });
  const now_ms = Date.now();
  const expired = parked.filter((status) => isExpiredEffectWorkflow(status, now_ms));
  const expired_ids = new Set(expired.map((status) => status.workflowID));
  const resumable = parked.filter((status) => !expired_ids.has(status.workflowID));
  if (resumable.length) await DBOS.resumeWorkflows(resumable.map((status) => status.workflowID));
  for (const status of expired) await settleExpiredEffect(status.workflowID);
  const runs = await db.query<{ id: string }>("SELECT r.id FROM authority.run r WHERE EXISTS (SELECT 1 FROM authority.scope_instance s WHERE s.run_id=r.id AND s.parent_id IS NULL AND NOT s.is_terminal) ORDER BY r.id", []);
  for (const run of runs) await ensureRunWorkflow(run.id);
  return runs.length;
}

/**
 * Shutdown: our workflows wait on wakes and observations for as long as a run
 * lives, so a clean stop parks them (DBOS cancel) and the next boot resumes
 * them. Nothing durable changes; the authority rows are untouched.
 */
export async function parkRunningWorkflows(): Promise<number> {
  const running = await DBOS.listWorkflows({ status: ["PENDING", "ENQUEUED"], workflowName: WORKFLOW_NAMES });
  if (running.length) await DBOS.cancelWorkflows(running.map((status) => status.workflowID));
  return running.length;
}
