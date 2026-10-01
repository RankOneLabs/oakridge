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

import { attemptIdFor, attemptWorkflowId, cohortMachineWorkflowId, runMachineWorkflowId, sessionIdFor, stageMachineWorkflowId, transitionIdFor } from "../decision/ids";
import { executorHealthFromTerminal, type AttemptExecution, type CohortMachineState, type OpenCohort, type RecordCohortEvent, type RetryCohortResult, type RetryCohortTarget, type RunDecision, type TransitionEffectDescriptor } from "../domain/run-record";
import { selectCohortRetryability } from "../domain/cohort-retry";
import { ExecutorStartRejectedError, type ExecutorAdapter, type ExecutorObservationAttempt, type ExternalExecutionReference } from "../domain/execution";
import type { AttemptId, CohortId, JsonValue, KbblSessionId, RunTransitionId, StageInstanceId, UnitId, WorkflowRunId } from "../domain/primitives";
import { executorOperationIdForWorkOrder, type ExecutionId, type WorkOrderId } from "../domain/primitives";
import type { TransitionOwner } from "../domain/run-record";
import type { Command, StageInputSet } from "../decision/commands";
import { parseStageInputEdges } from "../domain/stage-contract";
import type { ArtifactEnvelope } from "../domain/execution";
import type { RunArtifactReadRepository, RunRecordRepository, StageInstanceRepository } from "../storage/repositories";
import { MACHINE_WAKE_TOPIC, sendCohortWakeHint, sendRunWakeHint } from "../http/dbos-transport";

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

export const cohortMachineAddress = (cohort_id: CohortId): DecisionMachineAddress => ({
  owner: { kind: "cohort", id: cohort_id },
  workflow_id: cohortMachineWorkflowId(cohort_id),
});

/** A command is routed only to the machine that owns its optimistic version. */
export const machineAddressFor = (command: Command): DecisionMachineAddress => {
  if (command.kind === "transition_run") return runMachineAddress(command.run_id);
  if (command.kind === "transition_stage") return stageMachineAddress(command.stage_instance_id);
  return cohortMachineAddress(command.cohort_id);
};

/** The bound on how long a lost or never-sent wake can delay a recheck. */
export const MACHINE_WAKE_TIMEOUT_SECONDS = 60;
/** How long a machine sleeps, durably, after a run of failed asks. */
export const MACHINE_FAILURE_BACKOFF_SECONDS = 30;
const OBSERVE_INTERVAL_SECONDS = 5;

/* ------------------------------------------------------------------ *
 * The adapter boundary
 * ------------------------------------------------------------------ */

/** What a cohort machine's driver is asked to decide, over committed facts only. */
export interface CohortStepContext {
  readonly state: CohortMachineState;
  readonly stage_contract: JsonValue;
  readonly run_context: JsonValue;
  /**
   * The stage's declared inputs, from the accepted artifacts of the stages that
   * produce them. Resolved here rather than by each driver: which upstream slot
   * feeds which input was fixed when the stage was opened, and a driver
   * re-deriving it would be re-reading a definition the run is pinned away from.
   */
  readonly inputs: StageInputSet;
}

/**
 * One driver decision: the cohort transition to commit, and — when that
 * transition launches work — the attempt it names.
 *
 * The attempt's execution request is resolved by the driver, because resolving
 * it needs the stage's definition config and the prompt the transition selected.
 * Core commits the transition and starts the workflow; it never reads the
 * request.
 */
export interface CohortStepDecision {
  readonly event: Omit<RecordCohortEvent, "run_id" | "cohort_id" | "expected_version" | "recorded_at">;
  readonly launch: {
    readonly attempt_number: number;
    readonly adapter_type: string;
    readonly resolve_request: (attempt_id: AttemptId, launch_transition_id: RunTransitionId) => Promise<AttemptExecution["request"]>;
  } | null;
}

/**
 * How a stage type opens its cohorts and advances them.
 *
 * Registered rather than imported: core carries adapter-owned names through
 * durable records without closing over any of them, which is the rule
 * `tests/architecture.test.ts` holds the decision layer to.
 */
export interface CohortMachineDriver {
  readonly stage_type: string;
  /**
   * The cohort roster a started stage fans out over.
   *
   * The stage's resolved inputs come with it, because a fan-out binding may name
   * an *input* rather than the run context — dev-flow's build stage fans out over
   * the briefs the planning stage produced — and a roster resolved without them
   * cannot open a single cohort.
   */
  open_cohorts(input: { readonly run_id: WorkflowRunId; readonly stage_instance_id: StageInstanceId; readonly stage_contract: JsonValue; readonly run_context: JsonValue; readonly inputs: StageInputSet }): Promise<readonly OpenCohort[]>;
  /** The next transition this cohort owes, or null when it is waiting on something outside itself. */
  step(context: CohortStepContext): Promise<CohortStepDecision | null>;
  /**
   * The transition an externally-supplied fact implies — a pull request the
   * forge reported, a merge an operator confirmed. The payload is adapter-owned,
   * so the driver decodes it; core only commits the answer.
   */
  apply_event(context: CohortStepContext, event: JsonValue): Promise<CohortStepDecision | null>;
}

export interface RunRecordWorkflowServices {
  readonly records: RunRecordRepository;
  readonly stages: StageInstanceRepository;
  /** Reads the accepted revisions that fill a producing stage's declared output. */
  readonly artifacts: RunArtifactReadRepository;
  /** The run's own context, which drivers resolve their bindings against. */
  find_run_context(run_id: WorkflowRunId): Promise<JsonValue | null>;
  find_driver(stage_type: string): CohortMachineDriver | undefined;
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
    const stage = await stages.find_by_id(stage_instance_id);
    if (!stage) throw new Error(`stage instance '${stage_instance_id}' was not found`);
    const driver = workflowServices().find_driver(stage.stage_type);
    if (!driver) throw new Error(`stage type '${stage.stage_type}' has no registered cohort driver`);
    const run_context = await workflowServices().find_run_context(contract.run_id);
    if (run_context === null) throw new Error(`run '${contract.run_id}' was not found`);
    const inputs = await loadStageInputs(contract.stage_contract, null);
    let cohorts: readonly OpenCohort[];
    try {
      cohorts = await driver.open_cohorts({ run_id: contract.run_id, stage_instance_id,
        stage_contract: contract.stage_contract, run_context, inputs });
      if (cohorts.length === 0) throw new Error("cohort roster is empty");
    } catch (error) {
      const detail = String(error);
      await records.fail_stage_roster(stage_instance_id, detail, now());
      await sendRunWakeHint(contract.run_id, `roster_failed:${stage_instance_id}`).catch(() => undefined);
      return { kind: "roster_failed", detail };
    }
    const opened = await records.open_stage_cohorts({ run_id: contract.run_id, stage_instance_id, cohorts, opened_at: now() });
    if (opened.kind === "stage_not_found") throw new Error(opened.detail);
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
    for (const cohort of result.cohort_ids) {
      await DBOS.startWorkflow(cohortMachineWorkflow, { workflowID: cohortMachineWorkflowId(cohort) })(cohort);
    }
    return result;
  }
}, { name: "oakridgeV15StageWorkflow" });

/* ------------------------------------------------------------------ *
 * The cohort machine
 * ------------------------------------------------------------------ */

export interface CohortStepOutcome {
  readonly status: CohortMachineState["status"];
  readonly committed: boolean;
  readonly should_reread: boolean;
  readonly started_attempt: AttemptId | null;
  readonly launch_commit?: { readonly kind: "created" | "already_created"; readonly durable_version: number };
  /**
   * The cohort's attempt that still needs its workflow running — this pass's
   * launch, or an unfinished attempt somebody else created.
   *
   * Two paths create attempts outside any machine: operator retry through the
   * driver, and an adapter event. Neither starts a workflow directly — the
   * retry route has no handle on the topology and the event path returns an
   * outcome the caller discards — so the attempt row existed, the previous attempt
   * was abandoned, and no session ever launched. There is no attempt-level
   * sweeper: `run-launch-dispatch` covers runs only.
   */
  readonly open_attempt: AttemptId | null;
}

/** The cohort, its stage's pinned contract, its run's context, and its driver. */
const cohortContext = async (cohort_id: CohortId): Promise<{ readonly context: CohortStepContext; readonly driver: CohortMachineDriver }> => {
  const { records, stages } = workflowServices();
  const state = await records.find_cohort_state(cohort_id);
  if (!state) throw new Error(`cohort '${cohort_id}' was not found`);
  const stage = await stages.find_by_id(state.stage_instance_id);
  const contract = await stages.find_contract(state.stage_instance_id);
  if (!stage || !contract) throw new Error(`stage instance '${state.stage_instance_id}' was not found`);
  const driver = workflowServices().find_driver(stage.stage_type);
  if (!driver) throw new Error(`stage type '${stage.stage_type}' has no registered cohort driver`);
  const run_context = await workflowServices().find_run_context(state.run_id);
  if (run_context === null) throw new Error(`run '${state.run_id}' was not found`);
  const inputs = await loadStageInputs(contract.stage_contract, state.cohort_key);
  return { context: { state, stage_contract: contract.stage_contract, run_context, inputs }, driver };
};

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
const loadStageInputs = async (stage_contract: JsonValue, cohort_key: string | null): Promise<StageInputSet> => {
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

/**
 * Commits one driver decision, and starts the attempt it names.
 *
 * The execution request is resolved **before** the transition is committed, even
 * though it needs the transition's id. That id is derivable — `transitionIdFor`
 * is a pure function of the owner and the version the commit will produce — and
 * resolving afterwards was a real way to strand a cohort: a resolution that
 * throws (an unresolvable binding, a prompt cell the pinned bundle does not
 * carry) left the launch transition committed with no attempt behind it, so the
 * cohort read as `active` with nothing running and no machine could tell.
 * Resolving first makes that failure happen before anything is durable.
 *
 * A version conflict is not an error: another writer — the reconciler pushing a
 * forge fact, the operator's retry — got there first, and the next read sees
 * their commit. Reported as "nothing committed" so the caller loops rather than
 * retries a stale version.
 */
const commitCohortDecision = async (
  context: CohortStepContext,
  decision: CohortStepDecision | null,
  idempotency_key: string | null = null,
): Promise<CohortStepOutcome> => {
  const { records, now } = workflowServices();
  const { state } = context;
  const open_attempt = state.latest_unfinished_attempt_id;
  if (!decision) return { status: state.status, committed: false, should_reread: false, started_attempt: null, open_attempt };

  const owner: TransitionOwner = { kind: "cohort", id: state.cohort_id };
  const launch = decision.launch;
  const prepared = launch === null ? null : await (async () => {
    const attempt_id = attemptIdFor(state.cohort_id, launch.attempt_number);
    const launch_transition_id = transitionIdFor(owner, state.durable_version + 1);
    return { attempt_id, launch_transition_id,
      request: await launch.resolve_request(attempt_id, launch_transition_id) };
  })();

  const event: RecordCohortEvent = { ...decision.event, run_id: state.run_id, cohort_id: state.cohort_id,
    expected_version: state.durable_version, recorded_at: now() };
  if (launch !== null && prepared !== null) {
    const committed = await records.commit_cohort_launch({ event, attempt: {
      run_id: state.run_id, stage_instance_id: state.stage_instance_id, cohort_id: state.cohort_id,
      attempt_id: prepared.attempt_id, attempt_number: launch.attempt_number,
      adapter_type: launch.adapter_type, request: prepared.request,
      launch_transition_id: prepared.launch_transition_id, session_id: sessionIdFor(prepared.attempt_id),
      idempotency_key, created_at: now(),
    } });
    if (!committed.ok) {
      if (committed.error.kind === "version_conflict" || committed.error.kind === "owner_terminal") return {
        status: state.status, committed: false, should_reread: true, started_attempt: null, open_attempt: null };
      throw new Error(`${committed.error.kind}: ${committed.error.detail}`);
    }
    if (committed.value.kind === "created") {
      await sendRunWakeHint(state.run_id, `cohort_transition:${committed.value.transition.transition_id}`).catch(() => undefined);
    }
    return { status: decision.event.change.status, committed: committed.value.kind === "created", should_reread: false,
      started_attempt: committed.value.attempt_id, open_attempt: committed.value.attempt_id,
      launch_commit: { kind: committed.value.kind, durable_version: committed.value.durable_version } };
  }
  const recorded = await records.record_cohort_event(event);
  if (recorded.kind === "version_conflict" || recorded.kind === "owner_terminal") return {
    status: state.status, committed: false, should_reread: true, started_attempt: null, open_attempt: null };
  if (recorded.kind !== "recorded") throw new Error(`${recorded.kind}: ${recorded.detail}`);
  await sendRunWakeHint(state.run_id, `cohort_transition:${recorded.transition.transition_id}`).catch(() => undefined);
  return { status: decision.event.change.status, committed: true, should_reread: false,
    started_attempt: null, open_attempt };
};

const stepCohortStep = DBOS.registerStep(
  async (cohort_id: CohortId): Promise<CohortStepOutcome> => {
    const { context, driver } = await cohortContext(cohort_id);
    // A terminal cohort's attempts have been abandoned with it; starting one would
    // drive a session for work nothing is waiting on.
    if (isTerminal(context.state.status)) return { status: context.state.status, committed: false, should_reread: false,
      started_attempt: null, open_attempt: null };
    return commitCohortDecision(context, await driver.step(context));
  },
  { name: "oakridgeV15CohortStepStep", retriesAllowed: true, maxAttempts: 5, intervalSeconds: 1, backoffRate: 2 },
);

/**
 * Commits an externally-supplied cohort fact — the forge poller's observation,
 * an operator's confirmed merge — outside any machine's loop.
 *
 * It goes through the same driver and the same single-writer commit as the
 * machine's own step, under the cohort's current version, so a push and a step
 * racing each other cause one version conflict and a fresh read.
 */
export const recordCohortAdapterEvent = async (cohort_id: CohortId, event: JsonValue): Promise<CohortStepOutcome> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { context, driver } = await cohortContext(cohort_id);
    if (isTerminal(context.state.status)) return { status: context.state.status, committed: false,
      should_reread: false, started_attempt: null, open_attempt: null };
    const outcome = await commitCohortDecision(context, await driver.apply_event(context, event));
    if (!outcome.should_reread) return outcome;
  }
  return { status: (await cohortContext(cohort_id)).context.state.status, committed: false,
    should_reread: true, started_attempt: null, open_attempt: null };
};

export const retryCohortThroughDriver = async (
  target: RetryCohortTarget, idempotency_key: string,
): Promise<RetryCohortResult> => {
  const records = workflowServices().records;
  const cohort_id = target.kind === "cohort" ? target.cohort_id
    : (await records.find_cohort_location(target.stage_instance_id, target.cohort_key as UnitId))?.cohort_id;
  if (!cohort_id) return { kind: "cohort_not_found", detail: `no cohort matches ${JSON.stringify(target)}` };
  if (!(await records.find_cohort_state(cohort_id))) {
    return { kind: "cohort_not_found", detail: `no cohort matches ${JSON.stringify(target)}` };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { context, driver } = await cohortContext(cohort_id);
    const claimed = await records.find_cohort_retry_claim(cohort_id, idempotency_key);
    if (claimed) return { kind: "already_created", run_id: context.state.run_id, cohort_id,
      attempt_id: claimed.attempt_id, attempt_number: claimed.attempt_number,
      durable_version: claimed.durable_version };
    const retryability = selectCohortRetryability(context.state);
    if (retryability.kind === "not_retryable") return retryability;
    const decision = await driver.apply_event(context, { kind: "operator_retry_requested" });
    if (!decision?.launch) return { kind: "not_retryable", reason: "not_lost" };
    const outcome = await commitCohortDecision(context, decision, idempotency_key);
    if (outcome.should_reread) continue;
    if (!outcome.started_attempt) return { kind: "not_retryable", reason: "not_lost" };
    if (outcome.launch_commit?.kind === "already_created") {
      const claimed = await records.find_cohort_retry_claim(cohort_id, idempotency_key);
      if (!claimed) throw new Error(`retry claim '${idempotency_key}' for cohort '${cohort_id}' disappeared`);
      return { kind: "already_created", run_id: context.state.run_id, cohort_id,
        attempt_id: claimed.attempt_id, attempt_number: claimed.attempt_number,
        durable_version: claimed.durable_version };
    }
    await sendCohortWakeHint(cohort_id, `operator_retry:${cohort_id}:${idempotency_key}`).catch(() => undefined);
    return { kind: "created", run_id: context.state.run_id, cohort_id,
      attempt_id: outcome.started_attempt, attempt_number: decision.launch.attempt_number,
      durable_version: outcome.launch_commit?.durable_version ?? context.state.durable_version + 1 };
  }
  return { kind: "not_retryable", reason: "work_in_progress" };
};

/**
 * The only writer of one cohort's transitions.
 *
 * Its driver sees committed facts and nothing else — the cohort's own
 * `stage_data`, the artifacts accepted under it, its status — so a replay after
 * recovery reaches the same decision from the same rows rather than from
 * whatever an in-memory machine remembered.
 */
export const cohortMachineWorkflow = DBOS.registerWorkflow(async (cohort_id: CohortId): Promise<CohortMachineState["status"]> => {
  for (;;) {
    let outcome: CohortStepOutcome;
    try {
      outcome = await stepCohortStep(cohort_id);
    } catch (error) {
      DBOS.logger.error(`cohort ${cohort_id}: step failed, retrying in ${MACHINE_FAILURE_BACKOFF_SECONDS}s: ${String(error)}`);
      await DBOS.sleepSeconds(MACHINE_FAILURE_BACKOFF_SECONDS);
      continue;
    }
    // Started unconditionally, not only for this pass's own launch. The workflow id
    // is derived from the attempt id, so a second start joins the first rather than
    // opening anything — which makes this the one place that covers an attempt
    // created off-machine (an operator retry, an adapter event) *and* a crash
    // between the launch commit and its start.
    if (outcome.open_attempt) {
      await DBOS.startWorkflow(attemptWorkflow, { workflowID: attemptWorkflowId(outcome.open_attempt) })(outcome.open_attempt);
    }
    if (isTerminal(outcome.status)) return outcome.status;
    if (outcome.committed || outcome.should_reread) continue;
    await DBOS.recv(MACHINE_WAKE_TOPIC, { timeoutSeconds: MACHINE_WAKE_TIMEOUT_SECONDS });
  }
}, { name: "oakridgeV15CohortWorkflow" });

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

type EnsureSessionAttempt =
  | { readonly kind: "started"; readonly reference: ExternalExecutionReference }
  | { readonly kind: "abandoned" }
  | { readonly kind: "rejected"; readonly detail: string };

/** kbbl's own session id, when the adapter's handle carries one. */
const kbblSessionOf = (reference: ExternalExecutionReference): KbblSessionId | null =>
  reference.kind === "kbbl_session" ? reference.session_id as KbblSessionId : null;

export const ensureAttemptSession = async (
  deps: Pick<RunRecordWorkflowServices, "records" | "find_executor" | "now">,
  execution: AttemptExecution,
): Promise<EnsureSessionAttempt> => {
    const { records, now } = deps;
    const adapter = deps.find_executor(execution.adapter_type);
    if (!adapter) throw new Error(`executor adapter '${execution.adapter_type}' is not registered`);
    for (const prior of await records.list_prior_sessions_to_fence(execution.cohort_id, execution.attempt_id)) {
      await adapter.cancel_or_fence(prior.attempt_id as unknown as ExecutionId, prior.adapter_reference);
      await records.mark_session_fenced(prior.session_id, now());
      await records.observe_session({ session_id: prior.session_id,
        health: { kind: "ended_cancelled", detail: `replaced by attempt ${execution.attempt_number}`,
          observed_at: now() }, observed_at: now() });
    }
    let reference: ExternalExecutionReference;
    try {
      reference = await adapter.start_or_attach(execution.request,
        executorOperationIdForWorkOrder(execution.attempt_id as unknown as WorkOrderId));
    } catch (error) {
      if (error instanceof ExecutorStartRejectedError) return { kind: "rejected", detail: error.message };
      throw error;
    }
    const bound = await records.bind_session({ session_id: execution.session_id, adapter_reference: reference,
      kbbl_session_id: kbblSessionOf(reference), bound_at: now() });
    if (bound.kind === "attempt_ended") {
      await adapter.cancel_or_fence(execution.attempt_id as unknown as ExecutionId, reference);
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
    const { records, now } = workflowServices();
    const at = now();
    await records.observe_session({ session_id: input.execution.session_id,
      health: { kind: "ended_failed", code: "executor_start_failed", detail: input.detail, observed_at: at },
      observed_at: at });
    await sendCohortWakeHint(input.execution.cohort_id, `attempt_failed:${input.execution.attempt_id}`).catch(() => undefined);
  },
  { name: "oakridgeV15RecordSessionStartFailureStep", retriesAllowed: true },
);

type ObservedSessionAttempt = ExecutorObservationAttempt | { readonly kind: "abandoned" };

const observeSessionStep = DBOS.registerStep(
  async (input: { readonly execution: AttemptExecution; readonly reference: ExternalExecutionReference }): Promise<ObservedSessionAttempt> => {
    const { records, now } = workflowServices();
    const adapter = workflowServices().find_executor(input.execution.adapter_type);
    if (!adapter) throw new Error(`executor adapter '${input.execution.adapter_type}' is not registered`);
    const observation = await adapter.observe_terminal(
      input.execution.request.execution_id as ExecutionId, input.reference);
    const at = now();
    const written = await records.observe_session({ session_id: input.execution.session_id,
      health: observation.kind === "terminal" ? executorHealthFromTerminal(observation.observation, at) : { kind: "running", observed_at: at },
      observed_at: at });
    if (written?.kind === "already_ended") {
      await adapter.cancel_or_fence(input.execution.attempt_id as unknown as ExecutionId, input.reference);
      await records.mark_session_fenced(input.execution.session_id, now());
      return { kind: "abandoned" };
    }
    if (observation.kind === "terminal") {
      await sendCohortWakeHint(input.execution.cohort_id, `attempt_ended:${input.execution.attempt_id}`).catch(() => undefined);
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
  const execution = await loadAttemptStep(attempt_id);
  const ensured = await ensureSessionStep(execution);
  if (ensured.kind === "rejected") {
    await recordSessionStartFailureStep({ execution, detail: ensured.detail });
    return;
  }
  if (ensured.kind === "abandoned") return;
  const reference = ensured.reference;
  for (;;) {
    const observation = await observeSessionStep({ execution, reference });
    if (observation.kind === "abandoned") return;
    if (observation.kind === "terminal") return;
    await DBOS.sleepSeconds(OBSERVE_INTERVAL_SECONDS);
  }
}, { name: "oakridgeV15AttemptWorkflow" });
