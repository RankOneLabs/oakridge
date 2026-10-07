import { DBOS, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import type { CoreClient } from "../core-client/client";
import type { CheckedValue } from "../core-client/generated-contracts";
import { deliverEvidence, undeliveredEvidence } from "../effects/evidence";
import { readIntent, type EffectIntent, type EffectPayload, type EffectStatus } from "../effects/intents";
import { bounded, exhaustStart, resolveObserve, resolveStart, resolveStop, settleObserveRetry, startAttemptsExhausted, type StartOutcome } from "../effects/outcomes";
import type { EffectProvider, ProviderResult } from "../effects/provider";
import { advanceChildren, type LifecycleFailure } from "../runtime/advance-children";
import { claimStartAttempt, persistEffectResult } from "../storage/effect-results";
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
}
export const DEFAULT_WORKFLOW_TIMING: WorkflowTiming = { retry_initial_seconds: 1, retry_cap_seconds: 30, observe_interval_seconds: 5, max_observe_unavailable_attempts: 10, wake_timeout_seconds: 30 };

let services: WorkflowServices | null = null;
export function registerWorkflowServices(value: WorkflowServices): void { services = value; }
function current(): WorkflowServices {
  if (!services) throw new Error("workflow services are not registered");
  return services;
}

export const RUN_WAKE_TOPIC = "oakridge-run-wake";
export const runWorkflowId = (run_id: string): string => `run:${run_id}`;
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
  readonly pending_starts: readonly string[];
  readonly pending_stops: readonly string[];
  readonly failures: readonly LifecycleFailure[];
}
/**
 * One recheck of a run: deliver configured lifecycle triggers, retry any
 * deferred evidence, and list the intents that still need a workflow. A scope
 * whose trigger is rejected is reported, not thrown — it never blocks the rest.
 */
const advanceRunStep = DBOS.registerStep(async (run_id: RunId): Promise<RunAdvance> => {
  const { db, core, mutations } = current();
  const failures: LifecycleFailure[] = [...await advanceChildren({ db, core, mutations, run_ids: [run_id] })];
  for (const row of await undeliveredEvidence(db, run_id)) {
    const delivery = await deliverEvidence(db, mutations, row);
    if (delivery.kind === "deferred") failures.push({ scope_id: row.scope_id, detail: `evidence ${row.payload.evidence?.id ?? row.id}: ${delivery.detail}` });
  }
  const intents = await db.query<{ id: string; status: EffectStatus }>(`SELECT e.id,e.status FROM authority.effect_intent e JOIN authority.scope_instance s ON s.id=e.scope_id
    WHERE s.run_id=$1 AND ((e.payload->>'action'='start' AND e.status IN ('pending','acknowledged')) OR e.status='cleanup_pending') ORDER BY e.id`, [run_id]);
  const roots = await db.query<{ is_terminal: boolean }>("SELECT is_terminal FROM authority.scope_instance WHERE run_id=$1 AND parent_id IS NULL", [run_id]);
  return { is_terminal: roots[0]?.is_terminal ?? true,
    pending_starts: intents.filter((intent) => intent.status !== "cleanup_pending").map((intent) => intent.id),
    pending_stops: intents.filter((intent) => intent.status === "cleanup_pending").map((intent) => intent.id), failures };
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
      payload = settled.payload;
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
export const runWorkflow = DBOS.registerWorkflow(async (run_id: string): Promise<void> => {
  const timing = current().timing;
  const started = new Set<string>();
  for (;;) {
    let advance: RunAdvance;
    try { advance = await advanceRunStep(run_id as RunId); }
    catch (error) {
      // An outage that outlasts the step's own retries: stay alive, visible, and ask again.
      DBOS.logger.error(`run ${run_id}: recheck failed, retrying in ${timing.retry_cap_seconds}s: ${String(error)}`);
      await DBOS.sleepSeconds(timing.retry_cap_seconds);
      continue;
    }
    for (const failure of advance.failures) DBOS.logger.warn(`run ${run_id}: scope ${failure.scope_id}: ${failure.detail}`);
    for (const id of advance.pending_starts) if (!started.has(id)) { started.add(id); await DBOS.startWorkflow(effectWorkflow, { workflowID: id })(id); }
    for (const id of advance.pending_stops) if (!started.has(id)) { started.add(id); await DBOS.startWorkflow(cleanupWorkflow, { workflowID: id })(id); }
    if (advance.is_terminal && advance.pending_starts.length === 0 && advance.pending_stops.length === 0) return;
    await DBOS.recv(RUN_WAKE_TOPIC, { timeoutSeconds: timing.wake_timeout_seconds });
  }
}, { name: "oakridgeRunWorkflow" });

// ------------------------------------------------------------- entry -------

/** Starts the run workflow unless one is already live (or recovering) for this run. */
export async function ensureRunWorkflow(run_id: string): Promise<void> {
  const existing = await DBOS.getWorkflowStatus(runWorkflowId(run_id));
  if (existing && (existing.status === "PENDING" || existing.status === "ENQUEUED")) return;
  await DBOS.startWorkflow(runWorkflow, { workflowID: runWorkflowId(run_id) })(run_id);
}

/** A wake is a hint, never a fact: the run re-reads the authority on receipt. */
export async function wakeRun(run_id: string): Promise<void> {
  try { await DBOS.send(runWorkflowId(run_id), null, RUN_WAKE_TOPIC); }
  catch (error) { DBOS.logger.warn(`run ${run_id}: wake not delivered: ${String(error)}`); }
}
async function wakeRunOf(scope_id: string): Promise<void> {
  const rows = await current().db.query<{ run_id: string }>("SELECT run_id FROM authority.scope_instance WHERE id=$1", [scope_id]);
  if (rows[0]) await wakeRun(rows[0].run_id);
}

const WORKFLOW_NAMES = ["oakridgeRunWorkflow", "oakridgeEffectWorkflow", "oakridgeCleanupWorkflow"];

/**
 * Boot: workflows this engine parked at its last shutdown resume from their
 * last step, and every run whose root is still active gets its workflow back.
 */
export async function resumeActiveRuns(db: TransactionalSqlExecutor): Promise<number> {
  const parked = await DBOS.listWorkflows({ status: "CANCELLED", workflowName: WORKFLOW_NAMES });
  if (parked.length) await DBOS.resumeWorkflows(parked.map((status) => status.workflowID));
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
