/**
 * The v15 durable topology: one workflow per decision owner, plus one per
 * attempt.
 *
 * v14 had a single root workflow that asked one repository for the whole run's
 * next move. v15 scopes optimistic concurrency per owner — a run's
 * `record_version`, a stage's and a cohort's `durable_version` — so the topology
 * mirrors the ownership: the run machine decides the run and its stages, except
 * that a stage machine also fails its own stage when its roster cannot open;
 * both writes use the stage's expected version. A stage
 * machine opens its cohorts, and a cohort machine is the only thing that
 * transitions its own cohort. A command is routed to the machine that owns the
 * version it names (`machineAddressFor`), which is what makes a version
 * conflict impossible between two machines rather than merely retried.
 *
 * Every loop here is a *bounded recheck*: `DBOS.recv` either returns a wake hint
 * or times out, and either way the next line re-reads the authoritative record.
 * No decision is ever taken from a hint's payload or its absence, so a lost,
 * duplicated or out-of-order wake can only ever mean "ask again" — and asking
 * again is always safe.
 */
import { DBOS, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";
import type { StageEventApplier } from "../storage/apply-stage-event";
import { writeSessionStatus } from "../storage/postgres-run-record";
import type { SessionEndOutcome } from "../domain/stage-machine";

import { attemptWorkflowId, runMachineWorkflowId, stageMachineWorkflowId } from "../decision/ids";
import { type AttemptExecution, type OpenCohort, type RunDecision, type TransitionEffectDescriptor } from "../domain/run-record";
import { cohortIdFor, resolveCohortRoster } from "../adapters/cohort-roster";
import { ExecutorStartRejectedError, type ExecutionRequest, type ExecutorAdapter, type ExecutorObservationAttempt, type ExecutorUnavailable, type ExternalExecutionReference } from "../domain/execution";
import type { AttemptId, CohortId, JsonValue, KbblSessionId, RunTransitionId, StageInstanceId, UnitId, WorkflowRunId } from "../domain/primitives";
import { executorOperationIdForWorkOrder, type ExecutionId, type WorkOrderId } from "../domain/primitives";
import type { TransitionOwner } from "../domain/run-record";
import type { StageInputSet } from "../decision/commands";
import { parseStageInputEdges } from "../domain/stage-contract";
import type { ArtifactEnvelope } from "../domain/execution";
import type { RunArtifactReadRepository, RunRecordRepository, StageInstanceRepository } from "../storage/repositories";
import { MACHINE_WAKE_TOPIC, sendRunWakeHint } from "../http/dbos-transport";

export interface DecisionMachineAddress {
  readonly owner: TransitionOwner;
  readonly workflow_id: string;
}

export const runMachineAddress = (run_id: WorkflowRunId): DecisionMachineAddress => ({
  owner: { kind: "run", id: run_id },
  workflow_id: runMachineWorkflowId(run_id),
});

export const stageMachineAddress = (stage_instance_id: StageInstanceId): DecisionMachineAddress => ({
  owner: { kind: "stage_instance", id: stage_instance_id },
  workflow_id: stageMachineWorkflowId(stage_instance_id),
});

/** The bound on how long a lost or never-sent wake can delay a recheck. */
export const MACHINE_WAKE_TIMEOUT_SECONDS = 60;
/** How long a machine sleeps, durably, after a run of failed asks. */
export const MACHINE_FAILURE_BACKOFF_SECONDS = 30;
const OBSERVE_INTERVAL_SECONDS = 5;

export interface RunRecordWorkflowServices {
  readonly records: RunRecordRepository;
  readonly stages: StageInstanceRepository;
  /** Reads the accepted revisions that fill a producing stage's declared output. */
  readonly artifacts: RunArtifactReadRepository;
  readonly effects_sql?: TransactionalSqlExecutor;
  readonly stage_events?: StageEventApplier;
  resolve_attempt_request?(attempt_id: AttemptId): Promise<ExecutionRequest>;
  /** The run's own context, which drivers resolve their bindings against. */
  find_run_context(run_id: WorkflowRunId): Promise<JsonValue | null>;
  find_executor(executor_type: string): ExecutorAdapter | undefined;
  now(): string;
}

let services: RunRecordWorkflowServices | null = null;
export const registerRunRecordWorkflowServices = (value: RunRecordWorkflowServices): void => { services = value; };
const workflowServices = (): RunRecordWorkflowServices => {
  if (!services) throw new Error("run-record workflow services are not registered");
  return services;
};

/* ------------------------------------------------------------------ *
 * The run machine
 * ------------------------------------------------------------------ */

const decideRunStep = DBOS.registerStep(
  async (run_id: WorkflowRunId): Promise<RunDecision> => {
    const decided = await workflowServices().records.decide_run(run_id, workflowServices().now());
    if (!decided.ok) throw new Error(`${decided.error.operation}:${decided.error.kind}:${decided.error.detail}`);
    return decided.value;
  },
  { name: "oakridgeV15DecideRunStep", retriesAllowed: true, maxAttempts: 5, intervalSeconds: 1, backoffRate: 2 },
);

const isTerminal = (status: RunDecision["status"]): boolean =>
  status === "complete" || status === "failed" || status === "cancelled";

/** The stage instance a `start_stage` effect names, or null for any other effect. */
const startedStageOf = (effect: TransitionEffectDescriptor): StageInstanceId | null =>
  effect.kind === "start_stage" && typeof effect.stage_instance_id === "string"
    ? effect.stage_instance_id as StageInstanceId
    : null;

export interface RunMachineResult { readonly run_id: WorkflowRunId; readonly status: RunDecision["status"]; readonly outcome: RunDecision["outcome"] }

/**
 * The registered name of a run's root machine.
 *
 * Exported so the launch client enqueues by the same name the workflow is
 * registered under. Spelling it twice is how a launch came to enqueue a
 * workflow nothing served: DBOS records the row, the run reads as PENDING and
 * therefore alive, and no executor ever picks it up.
 */
export const RUN_MACHINE_WORKFLOW_NAME = "oakridgeV15RunWorkflow";

/**
 * The run's root workflow.
 *
 * Its only step is `decideRunStep`. Anything that step throws — a blip
 * outlasting its own `maxAttempts` — is caught, logged, and slept through
 * durably: the run stays visible in whatever state it is in, and the machine
 * asks again once the cause clears. A deleted run is the one case that ends the
 * workflow, because there is no longer a record to keep alive.
 */
export const runMachineWorkflow = DBOS.registerWorkflow(async (run_id: WorkflowRunId): Promise<RunMachineResult | null> => {
  for (;;) {
    let decision: RunDecision;
    try {
      decision = await decideRunStep(run_id);
    } catch (error) {
      if (error instanceof DBOSErrors.DBOSWorkflowCancelledError) return null;
      const message = String(error);
      if (message.includes("run_not_found")) return null;
      DBOS.logger.error(`run ${run_id}: decide failed, retrying in ${MACHINE_FAILURE_BACKOFF_SECONDS}s: ${message}`);
      await DBOS.sleepSeconds(MACHINE_FAILURE_BACKOFF_SECONDS);
      continue;
    }
    for (const transition of decision.transitions) {
      const stage = startedStageOf(transition.effect);
      if (!stage) continue;
      // Addressed by the stage's own machine id, not the transition's effect id:
      // one stage has one machine, and a replayed dispatch must join it rather
      // than start a second.
      await DBOS.startWorkflow(stageMachineWorkflow, { workflowID: stageMachineWorkflowId(stage) })(stage);
    }
    if (isTerminal(decision.status)) return { run_id, status: decision.status, outcome: decision.outcome };
    if (decision.transitions.length > 0) continue; // something changed: ask again now, no recv
    await DBOS.recv(MACHINE_WAKE_TOPIC, { timeoutSeconds: MACHINE_WAKE_TIMEOUT_SECONDS });
  }
}, { name: RUN_MACHINE_WORKFLOW_NAME });

/* ------------------------------------------------------------------ *
 * The stage machine
 * ------------------------------------------------------------------ */

type StageRosterResult = { readonly kind: "opened"; readonly cohort_ids: readonly CohortId[] }
  | { readonly kind: "roster_failed"; readonly detail: string };

const openStageCohortsStep = DBOS.registerStep(
  async (stage_instance_id: StageInstanceId): Promise<StageRosterResult> => {
    const { records, stages, now } = workflowServices();
    const contract = await stages.find_contract(stage_instance_id);
    if (!contract) throw new Error(`stage instance '${stage_instance_id}' was not found`);
    const run_context = await workflowServices().find_run_context(contract.run_id);
    if (run_context === null) throw new Error(`run '${contract.run_id}' was not found`);
    const inputs = await loadStageInputs(contract.stage_contract, null);
    let cohorts: readonly OpenCohort[];
    try {
      const stage_contract = contract.stage_contract as unknown as import("../domain/compiled-workflow").CompiledStageContract;
      cohorts = resolveCohortRoster(stage_contract, run_context, inputs).map((entry) => ({
        id: cohortIdFor(stage_instance_id, entry.cohort_key), cohort_key: entry.cohort_key,
        depends_on: entry.depends_on, stage_data: { unit_id: entry.cohort_key, artifact: entry.item },
      }));
      if (cohorts.length === 0) throw new Error("cohort roster is empty");
    } catch (error) {
      const detail = String(error);
      await records.fail_stage_roster(stage_instance_id, detail, now());
      await sendRunWakeHint(contract.run_id, `roster_failed:${stage_instance_id}`).catch(() => undefined);
      return { kind: "roster_failed", detail };
    }
    const opened = await records.open_stage_cohorts({ run_id: contract.run_id, stage_instance_id, cohorts, opened_at: now() });
    if ("detail" in opened) throw new Error(opened.detail);
    return { kind: "opened", cohort_ids: opened.cohort_ids };
  },
  { name: "oakridgeV15OpenStageCohortsStep", retriesAllowed: true },
);

/**
 * Materializes a started stage's cohorts and starts one machine per cohort,
 * then returns.
 *
 * It does not wait for them. A stage completes when every one of its cohorts is
 * `complete`, and that is `derive`'s decision taken by the *run* machine over a
 * transaction-consistent snapshot — not something a stage workflow could
 * conclude by watching its children's return values.
 */
export const stageMachineWorkflow = DBOS.registerWorkflow(async (stage_instance_id: StageInstanceId): Promise<StageRosterResult | null> => {
  for (;;) {
    let result: StageRosterResult;
    try {
      result = await openStageCohortsStep(stage_instance_id);
    } catch (error) {
      if (error instanceof DBOSErrors.DBOSWorkflowCancelledError) return null;
      DBOS.logger.error(`stage ${stage_instance_id}: roster failed, retrying in ${MACHINE_FAILURE_BACKOFF_SECONDS}s: ${String(error)}`);
      await DBOS.sleepSeconds(MACHINE_FAILURE_BACKOFF_SECONDS);
      continue;
    }
    if (result.kind === "roster_failed") return result;
    const { effects_sql, stage_events } = workflowServices();
    if (effects_sql && stage_events && result.cohort_ids.length > 0) {
      const effects = await effects_sql.query<{ readonly id: string }>(
        `SELECT id::text FROM oakridge.run_transition
         WHERE owner_cohort_id=ANY($1::uuid[]) AND effect_descriptor->>'external'='true'
           AND effects_started_at IS NULL`, [result.cohort_ids]);
      await stage_events.start_effects(effects.map((effect) => effect.id as RunTransitionId));
    }
    return result;
  }
}, { name: "oakridgeV15StageWorkflow" });

/* ------------------------------------------------------------------ *
 * The cohort machine
 * ------------------------------------------------------------------ */

/**
 * One stage's declared inputs, as artifact envelopes.
 *
 * A collecting input takes every accepted revision of its producer's slot. A
 * scalar one is *delivered per cohort* when its producer made several revisions —
 * that is what `delivery: unit_complete` means, and dev-flow's build stage reads
 * one brief out of the collection the planner wrote. At stage scope (`cohort_key`
 * is null, which is how the roster is resolved) the whole collection is kept,
 * because a fan-out iterates the collection rather than one member of it.
 *
 * An envelope's `unit_id` is its collection key when it has one. That key is the
 * item's identity for a collected output — it is what the fan-out reads its
 * cohort key from, what the prompt renders beside the body and what a publication
 * names the slot by — whereas the producing cohort's own key is `"0"` for every
 * revision a scalar producer wrote.
 *
 * An input whose producer has accepted nothing is left out rather than filled
 * with an empty array: `resolve_execution` reports a missing input by name, and
 * an empty array would instead render an empty list into the prompt as though the
 * upstream stage had produced nothing to say.
 */
export const loadStageInputs = async (stage_contract: JsonValue, cohort_key: string | null): Promise<StageInputSet> => {
  const { artifacts } = workflowServices();
  const resolved: Record<string, ArtifactEnvelope | readonly ArtifactEnvelope[]> = {};
  for (const edge of parseStageInputEdges(stage_contract)) {
    const revisions = await artifacts.list_released_for_stage_output(
      edge.producer_stage_instance_id as StageInstanceId, edge.producer_output);
    if (revisions.length === 0) continue;
    const envelopes = revisions.filter((revision): revision is typeof revision & { readonly output_name: string; readonly unit_id: UnitId } =>
      revision.output_name !== null && revision.unit_id !== null)
      .map((revision): ArtifactEnvelope => ({
      artifact_id: revision.id, artifact_type: revision.artifact_type, output_name: revision.output_name,
      unit_id: (revision.collection_key ?? revision.unit_id) as UnitId, collection_key: revision.collection_key,
      body: revision.body, chain_id: revision.chain_id,
      ...(revision.attempt_id ? { producer_execution_id: revision.attempt_id as unknown as ExecutionId } : {}),
    }));
    if (edge.collect || cohort_key === null) {
      resolved[edge.input_name] = envelopes;
      continue;
    }
    const selected = selectCohortInputEnvelope(envelopes, cohort_key);
    if (selected) resolved[edge.input_name] = selected;
  }
  return resolved;
};

export const selectCohortInputEnvelope = (
  envelopes: readonly ArtifactEnvelope[], cohort_key: string,
): ArtifactEnvelope | undefined => envelopes.some((envelope) => envelope.collection_key !== null)
  ? envelopes.find((envelope) => envelope.collection_key === cohort_key)
  : envelopes[0];

/* ------------------------------------------------------------------ *
 * The attempt
 * ------------------------------------------------------------------ */

const loadAttemptStep = DBOS.registerStep(
  async (attempt_id: AttemptId): Promise<AttemptExecution> => {
    const execution = await workflowServices().records.find_attempt_execution(attempt_id);
    if (!execution) throw new Error(`attempt '${attempt_id}' was not found`);
    return execution;
  },
  { name: "oakridgeV15LoadAttemptStep", retriesAllowed: true },
);

const resolveAttemptRequestStep = DBOS.registerStep(async (attempt_id: AttemptId): Promise<{
  readonly kind: "resolved" | "failed"; readonly detail: string | null }> => {
  const { effects_sql, resolve_attempt_request } = workflowServices();
  if (!effects_sql || !resolve_attempt_request) throw new Error("attempt resolution is not configured");
  const stored = await effects_sql.query<{ readonly request: JsonValue | null }>(
    "SELECT request FROM oakridge.attempt WHERE id=$1", [attempt_id]);
  if (!stored[0]) return { kind: "failed", detail: "attempt is missing" };
  if (stored[0].request !== null) return { kind: "resolved", detail: null };
  try {
    const request = await resolve_attempt_request(attempt_id);
    await effects_sql.query("UPDATE oakridge.attempt SET request=$2::jsonb WHERE id=$1 AND request IS NULL",
      [attempt_id, JSON.stringify(request)]);
    return { kind: "resolved", detail: null };
  } catch (error) {
    return { kind: "failed", detail: String(error) };
  }
}, { name: "oakridgeV15ResolveAttemptRequestStep", retriesAllowed: true });

const recordAttemptOutcome = async (execution: AttemptExecution, status: "complete" | "failed" | "cancelled",
  outcome: SessionEndOutcome): Promise<void> => {
  const { effects_sql, stage_events, now } = workflowServices();
  if (!effects_sql || !stage_events) throw new Error("stage event ingress is not configured");
  const transition_ids: RunTransitionId[] = [];
  await effects_sql.transaction(async (tx) => {
    const written = await writeSessionStatus(tx, { session_id: execution.session_id, status, at: now() });
    if (written.kind === "already_ended") return;
    const applied = await stage_events.apply_in(tx, execution.cohort_id,
      { kind: "session_ended", attempt_id: execution.attempt_id, outcome }, transition_ids);
    if (!applied.ok) throw new Error(`${applied.error.kind}: ${applied.error.detail}`);
  });
  await stage_events.start_effects(transition_ids);
  await sendRunWakeHint(execution.run_id, `session_ended:${execution.attempt_id}`).catch(() => undefined);
};

type EnsureSessionAttempt =
  | { readonly kind: "started"; readonly reference: ExternalExecutionReference }
  | { readonly kind: "abandoned" }
  | { readonly kind: "rejected"; readonly detail: string }
  | ExecutorUnavailable;

/** kbbl's own session id, when the adapter's handle carries one. */
const kbblSessionOf = (reference: ExternalExecutionReference): KbblSessionId | null =>
  reference.kind === "kbbl_session" ? reference.session_id as KbblSessionId : null;

export const ensureAttemptSession = async (
  deps: Pick<RunRecordWorkflowServices, "records" | "find_executor" | "now">,
  execution: AttemptExecution,
): Promise<EnsureSessionAttempt> => {
    const { records, now } = deps;
    if (execution.request === null) return { kind: "rejected", detail: "attempt request is unresolved" };
    const adapter = deps.find_executor(execution.adapter_type);
    if (!adapter) throw new Error(`executor adapter '${execution.adapter_type}' is not registered`);
    for (const prior of await records.list_prior_sessions_to_fence(execution.cohort_id, execution.attempt_id)) {
      const fenced = await adapter.cancel_or_fence(prior.attempt_id as unknown as ExecutionId, prior.adapter_reference);
      if (fenced?.kind === "executor_unavailable") return fenced;
      await records.mark_session_fenced(prior.session_id, now());
      await records.observe_session({ session_id: prior.session_id,
        health: { kind: "ended_cancelled", detail: `replaced by attempt ${execution.attempt_number}`,
          observed_at: now() }, observed_at: now() });
    }
    let reference: ExternalExecutionReference | ExecutorUnavailable;
    try {
      reference = await adapter.start_or_attach(execution.request,
        executorOperationIdForWorkOrder(execution.attempt_id as unknown as WorkOrderId));
    } catch (error) {
      if (error instanceof ExecutorStartRejectedError) return { kind: "rejected", detail: error.message };
      throw error;
    }
    if (reference.kind === "executor_unavailable") return reference;
    const bound = await records.bind_session({ session_id: execution.session_id, adapter_reference: reference,
      kbbl_session_id: kbblSessionOf(reference), bound_at: now() });
    if (bound.kind === "attempt_ended") {
      const fenced = await adapter.cancel_or_fence(execution.attempt_id as unknown as ExecutionId, reference);
      if (fenced?.kind === "executor_unavailable") return fenced;
      await records.mark_session_fenced(execution.session_id, now());
      return { kind: "abandoned" };
    }
    return { kind: "started", reference };
};

const ensureSessionStep = DBOS.registerStep(
  (execution: AttemptExecution): Promise<EnsureSessionAttempt> => ensureAttemptSession(workflowServices(), execution),
  { name: "oakridgeV15EnsureSessionStep", retriesAllowed: true },
);

/**
 * A start failure has no external handle for the observer to poll, so the
 * rejection itself must become the durable fact that makes the attempt
 * retryable — otherwise the cohort waits forever on a session that was never
 * created.
 */
const recordSessionStartFailureStep = DBOS.registerStep(
  async (input: { readonly execution: AttemptExecution; readonly detail: string }): Promise<void> => {
    await recordAttemptOutcome(input.execution, "failed",
      { kind: "failed", code: "executor_start_failed", detail: input.detail });
  },
  { name: "oakridgeV15RecordSessionStartFailureStep", retriesAllowed: true },
);

type ObservedSessionAttempt = ExecutorObservationAttempt | ExecutorUnavailable | { readonly kind: "abandoned" };

const observeSessionStep = DBOS.registerStep(
  async (input: { readonly execution: AttemptExecution; readonly reference: ExternalExecutionReference }): Promise<ObservedSessionAttempt> => {
    const { records, now } = workflowServices();
    const adapter = workflowServices().find_executor(input.execution.adapter_type);
    if (!adapter) throw new Error(`executor adapter '${input.execution.adapter_type}' is not registered`);
    if (input.execution.request === null) throw new Error("attempt request is unresolved");
    const observation = await adapter.observe_terminal(
      input.execution.request.execution_id as ExecutionId, input.reference);
    if (observation.kind === "executor_unavailable") return observation;
    const at = now();
    const written = observation.kind === "terminal" ? null : await records.observe_session({ session_id: input.execution.session_id,
      health: { kind: "running", observed_at: at }, observed_at: at });
    if (written?.kind === "already_ended") {
      const fenced = await adapter.cancel_or_fence(input.execution.attempt_id as unknown as ExecutionId, input.reference);
      if (fenced?.kind === "executor_unavailable") return fenced;
      await records.mark_session_fenced(input.execution.session_id, now());
      return { kind: "abandoned" };
    }
    if (observation.kind === "terminal") {
      const terminal = observation.observation;
      const status = terminal.kind === "succeeded" ? "complete" : terminal.kind === "cancelled" ? "cancelled" : "failed";
      const outcome: SessionEndOutcome = terminal.kind === "succeeded" ? { kind: "exited", exit_code: 0 }
        : terminal.kind === "failed" ? { kind: "failed", code: terminal.code, detail: terminal.detail }
          : { kind: "cancelled" };
      await recordAttemptOutcome(input.execution, status, outcome);
    }
    return observation;
  },
  { name: "oakridgeV15ObserveSessionStep", retriesAllowed: true },
);

/**
 * One attempt: ensure its session, then observe until the adapter reports a
 * terminal turn.
 *
 * It does not decide what the terminal observation *means*. A finished turn is
 * not a finished cohort — the artifact may still be waiting on a gate, and a
 * rejected one brings the agent back — so the observation is recorded and the
 * cohort machine takes it from there under its own version.
 */
export const attemptWorkflow = DBOS.registerWorkflow(async (attempt_id: AttemptId): Promise<void> => {
  let execution = await loadAttemptStep(attempt_id);
  if (execution.request === null) {
    const resolved = await resolveAttemptRequestStep(attempt_id);
    if (resolved.kind === "failed") {
      await recordAttemptOutcome(execution, "failed", { kind: "failed", code: "launch_resolution_failed",
        detail: resolved.detail ?? "attempt request could not be resolved" });
      return;
    }
    execution = await loadAttemptStep(attempt_id);
  }
  let reference: ExternalExecutionReference;
  for (;;) {
    const ensured = await ensureSessionStep(execution);
    if (ensured.kind === "executor_unavailable") {
      await DBOS.sleepSeconds(10);
      continue;
    }
    if (ensured.kind === "rejected") {
      await recordSessionStartFailureStep({ execution, detail: ensured.detail });
      return;
    }
    if (ensured.kind === "abandoned") return;
    reference = ensured.reference;
    break;
  }
  for (;;) {
    const observation = await observeSessionStep({ execution, reference });
    if (observation.kind === "abandoned") return;
    if (observation.kind === "terminal") return;
    await DBOS.sleepSeconds(observation.kind === "executor_unavailable" ? 10 : OBSERVE_INTERVAL_SECONDS);
  }
}, { name: "oakridgeV15AttemptWorkflow" });

interface StageEffectTransitionRow {
  readonly id: string;
  readonly owner_cohort_id: string;
  readonly effect_workflow_id: string;
  readonly effect_descriptor: { readonly kind: string; readonly effects?: readonly { readonly name: string }[] };
}

const markStageEffectsStartedStep = DBOS.registerStep(async (transition_id: RunTransitionId): Promise<StageEffectTransitionRow> => {
  const sql = workflowServices().effects_sql;
  if (!sql) throw new Error("stage effect SQL is not registered");
  const rows = await sql.query<StageEffectTransitionRow>(
    `UPDATE oakridge.run_transition SET effects_started_at=COALESCE(effects_started_at,clock_timestamp())
     WHERE id=$1 RETURNING id::text,owner_cohort_id::text,effect_workflow_id,effect_descriptor`, [transition_id]);
  if (!rows[0]) throw new Error(`transition '${transition_id}' is missing`);
  return rows[0];
}, { name: "oakridgeV15MarkStageEffectsStartedStep", retriesAllowed: true });

const startStageAttemptsStep = DBOS.registerStep(async (transition_id: RunTransitionId): Promise<readonly AttemptId[]> => {
  const sql = workflowServices().effects_sql;
  if (!sql) throw new Error("stage effect SQL is not registered");
  const rows = await sql.query<{ readonly id: string }>(
    `SELECT attempt.id::text FROM oakridge.attempt attempt
     JOIN oakridge.session session ON session.attempt_id=attempt.id
     WHERE session.launch_transition_id=$1 ORDER BY attempt.attempt_number`, [transition_id]);
  return rows.map((row) => row.id as AttemptId);
}, { name: "oakridgeV15FindStageAttemptsStep", retriesAllowed: true });

const fenceStageSessionsStep = DBOS.registerStep(async (cohort_id: CohortId): Promise<void | ExecutorUnavailable> => {
  const { effects_sql, records, find_executor, now } = workflowServices();
  if (!effects_sql) throw new Error("stage effect SQL is not registered");
  const rows = await effects_sql.query<{ readonly session_id: string; readonly adapter_type: string;
    readonly adapter_reference: ExternalExecutionReference; readonly execution_id: string }>(
    `SELECT session.id::text AS session_id,attempt.adapter_type,session.adapter_reference,
            attempt.id::text AS execution_id
     FROM oakridge.session session JOIN oakridge.attempt attempt ON attempt.id=session.attempt_id
     WHERE attempt.cohort_id=$1 AND session.fenced_at IS NULL AND session.kbbl_session_id IS NOT NULL
     ORDER BY attempt.attempt_number`, [cohort_id]);
  for (const row of rows) {
    const adapter = find_executor(row.adapter_type);
    if (!adapter) throw new Error(`executor '${row.adapter_type}' is not registered`);
    const fenced = await adapter.cancel_or_fence(row.execution_id as ExecutionId, row.adapter_reference);
    if (fenced?.kind === "executor_unavailable") return fenced;
    await records.mark_session_fenced(row.session_id as import("../domain/primitives").SessionId, now());
  }
}, { name: "oakridgeV15FenceStageSessionsStep", retriesAllowed: true });

export const stageEffectWorkflow = DBOS.registerWorkflow(async (transition_id: RunTransitionId): Promise<void> => {
  const row = await markStageEffectsStartedStep(transition_id);
  for (const effect of row.effect_descriptor.effects ?? []) {
    if (effect.name === "launch_session") {
      for (const attempt_id of await startStageAttemptsStep(transition_id)) {
        await DBOS.startWorkflow(attemptWorkflow, { workflowID: attemptWorkflowId(attempt_id) })(attempt_id);
      }
    } else if (effect.name === "end_session" && row.owner_cohort_id) {
      for (;;) {
        const fenced = await fenceStageSessionsStep(row.owner_cohort_id as CohortId);
        if (fenced?.kind !== "executor_unavailable") break;
        await DBOS.sleepSeconds(10);
      }
    }
  }
}, { name: "oakridgeV15StageEffectWorkflow" });
