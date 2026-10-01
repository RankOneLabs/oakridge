/**
 * The v15 run record.
 *
 * Every status change here goes through `PostgresRunRecordWriter`, which is the
 * one module that writes lifecycle status: an owner's status, its version bump
 * and the transition recording the effect commit together, so no caller can
 * observe a status without the transition that explains it. What this module
 * owns is everything hanging off those owners — stage instances, cohorts,
 * attempts, sessions, artifacts and waits.
 */
import { sessionIdFor } from "../decision/ids";
import { selectStartableCohorts } from "../decision/schedule-cohorts";
import type { ArtifactEnvelope, ExecutionRequest, ExternalExecutionReference } from "../domain/execution";
import { err, ok, type ArtifactId, type AttemptId, type CohortId, type JsonValue, type Result, type RunRecordVersion, type RunTransitionId, type SessionId, type StageInstanceId, type UnitId, type WaitId, type WorkflowRunId } from "../domain/primitives";
import type { BlockedReason, CoreStatus, NextActor } from "../domain/records";
import type { DeleteRunResult } from "../domain/runs";
import { findDeclaredOutput } from "../domain/stage-contract";
import type {
  AttemptExecution,
  BindSessionResult,
  BindSession,
  CohortLaunchCommitted,
  CohortLaunchCommitError,
  CommitCohortLaunch,
  CancelRunRecord,
  CancelRunRecordResult,
  CancelledRunSession,
  CloseRunOutputWaitResult,
  CohortMachineState,
  CommittedRunTransition,
  DecidedCohortGate,
  DecideGateWait,
  InitializeRun,
  InitializeRunResult,
  ObserveSession,
  OpenStageCohorts,
  OpenStageCohortsResult,
  PublishWorkOrderArtifact,
  PublishWorkOrderArtifactResult,
  RecordCohortEvent,
  RecordCohortEventResult,
  SessionStatusWrite,
  RunDecision,
  RunRecordRepositoryError,
  StartAttempt,
  StartAttemptResult,
} from "../domain/run-record";
import { capabilityFor, capabilityHash } from "../runtime/resolve-work-order";
import { loadRunSnapshot } from "./load-run-snapshot";
import { abandonCohortAttempts, writeSessionStatus, type PostgresRunRecordWriter } from "./postgres-run-record";
import type { StageEventApplier } from "./apply-stage-event";
import type { RunRecordRepository } from "./repositories";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";

const CAPABILITY_SECRET = "work_order_capability";
const isTerminalStatus = (status: CoreStatus): boolean => status === "complete" || status === "failed" || status === "cancelled";

class PublishAbort extends Error {
  constructor(readonly code: string, readonly detail: string) { super(detail); }
}


/** How many version races one owner's cancellation will lose before giving up. */
const CANCEL_OWNER_ATTEMPTS = 3;

const isObject = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const deliverableReference = (value: JsonValue): ExternalExecutionReference | null => {
  if (!isObject(value) || typeof value.kind !== "string") return null;
  if (value.kind === "kbbl_session" && typeof value.session_id === "string") {
    return { kind: "kbbl_session", session_id: value.session_id,
      ...(typeof value.worktree_base_sha === "string" ? { worktree_base_sha: value.worktree_base_sha } : {}) };
  }
  if (value.kind === "headless_run" && typeof value.run_ref === "string") return { kind: "headless_run", run_ref: value.run_ref };
  if (value.kind === "completed" || value.kind === "none") return value as unknown as ExternalExecutionReference;
  return null;
};

/** A session's status, from the last health fact the adapter reported. */
const statusFromHealth = (health: ObserveSession["health"]): CoreStatus => {
  if (health.kind === "running") return "active";
  if (health.kind === "ended_succeeded") return "complete";
  if (health.kind === "ended_cancelled") return "cancelled";
  return "failed";
};

interface CohortVersionRow {
  readonly id: string;
  readonly run_id: string;
  readonly stage_instance_id: string;
  readonly stage_key: string;
  readonly cohort_key: string;
  readonly status: CoreStatus;
  readonly blocked_reason: BlockedReason | null;
  readonly next_actor: NextActor | null;
  readonly durable_version: string;
  readonly stage_data: JsonValue;
}

const COHORT_STATE_COLUMNS = `cohort.id::text,cohort.run_id::text,cohort.stage_instance_id::text,stage.stage_key,
  cohort.cohort_key,cohort.status,cohort.blocked_reason,cohort.next_actor,
  cohort.durable_version::text,cohort.stage_data`;

interface AttemptRow {
  readonly id: string;
  readonly run_id: string;
  readonly stage_instance_id: string;
  readonly stage_key: string;
  readonly cohort_id: string;
  readonly cohort_key: string;
  readonly attempt_number: number;
  readonly status: CoreStatus;
  readonly adapter_type: string;
  readonly request: JsonValue | null;
  readonly session_id: string | null;
  readonly adapter_reference: JsonValue | null;
  readonly kbbl_session_id: string | null;
}

const ATTEMPT_COLUMNS = `attempt.id::text,attempt.run_id::text,attempt.stage_instance_id::text,stage.stage_key,
  attempt.cohort_id::text,cohort.cohort_key,attempt.attempt_number,attempt.status,attempt.adapter_type,attempt.request,
  session.id::text AS session_id,session.adapter_reference,session.kbbl_session_id`;

const ATTEMPT_SOURCE = `FROM oakridge.attempt attempt
  JOIN oakridge.cohort cohort ON cohort.id=attempt.cohort_id
  JOIN oakridge.stage_instance stage ON stage.id=attempt.stage_instance_id
  LEFT JOIN oakridge.session session ON session.attempt_id=attempt.id`;

const attemptExecution = (row: AttemptRow): AttemptExecution => ({
  attempt_id: row.id as AttemptId,
  session_id: (row.session_id ?? sessionIdFor(row.id as AttemptId)) as SessionId,
  run_id: row.run_id as WorkflowRunId,
  stage_instance_id: row.stage_instance_id as StageInstanceId,
  stage_key: row.stage_key,
  cohort_id: row.cohort_id as CohortId,
  cohort_key: row.cohort_key,
  attempt_number: row.attempt_number,
  status: row.status,
  request: row.request as unknown as ExecutionRequest | null,
  adapter_type: row.adapter_type,
  adapter_reference: row.adapter_reference === null ? null : deliverableReference(row.adapter_reference),
  kbbl_session_id: row.kbbl_session_id as AttemptExecution["kbbl_session_id"],
});

interface RunVersionRow { readonly status: CoreStatus; readonly record_version: string; readonly outcome: JsonValue | null }

const runVersion = async (sql: SqlExecutor, run_id: WorkflowRunId): Promise<RunVersionRow | null> => {
  const rows = await sql.query<RunVersionRow>(
    "SELECT status,record_version::text,outcome FROM oakridge.workflow_run WHERE id=$1", [run_id]);
  return rows[0] ?? null;
};

export class PostgresRunRecordRepository implements RunRecordRepository {
  private stage_event_applier: StageEventApplier | null = null;

  constructor(
    private readonly sql: TransactionalSqlExecutor,
    private readonly writer: PostgresRunRecordWriter,
  ) {}

  set_stage_event_applier(applier: StageEventApplier): void { this.stage_event_applier = applier; }

  /* ---------------- initialization and the decision loop ---------------- */

  /**
   * Opens every stage instance of the run's compiled graph, then commits the
   * run's own `pending → active` transition.
   *
   * All stages up front, not one when it becomes ready: `derive` closes over the
   * dependency graph, and a stage with no row is a dependency it cannot see. The
   * run's activation is the launch's own fact and not a derived one — `derive`
   * decides stage and cohort transitions and the run's terminal outcome, never
   * its start.
   */
  async initialize_run(input: InitializeRun): Promise<InitializeRunResult> {
    const opened = await this.sql.transaction(async (tx) => {
      const runs = await tx.query<{ readonly record_version: string }>(
        "SELECT record_version::text FROM oakridge.workflow_run WHERE id=$1 FOR UPDATE", [input.run_id]);
      if (!runs[0]) return null;
      for (const stage of input.stages) {
        await tx.query(
          `INSERT INTO oakridge.stage_instance (id,run_id,stage_key,stage_type,stage_contract,created_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz)
           ON CONFLICT (run_id,stage_key) DO NOTHING`,
          [stage.id, input.run_id, stage.stage_key, stage.stage_type, JSON.stringify(stage.stage_contract), input.initialized_at]);
      }
      return Number(runs[0].record_version);
    });
    if (opened === null) return { kind: "run_not_found", detail: `workflow run '${input.run_id}' was not found` };
    if (opened > 0) return { kind: "already_initialized", run_id: input.run_id };
    const activated = await this.writer.commit({
      run_id: input.run_id, owner: { kind: "run", id: input.run_id }, expected_version: 0,
      launch_reason: "initial",
      change: { status: "active", blocked_reason: null, next_actor: "core", outcome: null },
      effect: { kind: "none" }, actor: "core", changed_at: input.initialized_at,
    });
    // A lost race against another initializer is that initializer's success.
    if (!activated.ok && (activated.error.kind === "version_conflict" || activated.error.kind === "owner_terminal")) {
      return { kind: "already_initialized", run_id: input.run_id };
    }
    if (!activated.ok) return { kind: "run_not_found", detail: `run '${input.run_id}' could not be activated: ${activated.error.kind}` };
    return { kind: "initialized", run_id: input.run_id };
  }

  async decide_run(run_id: WorkflowRunId, decided_at: string): Promise<Result<RunDecision, RunRecordRepositoryError>> {
    const decided = await this.writer.decide({
        load_snapshot: (tx) => loadRunSnapshot(tx, run_id),
        // Every command `derive` emits is a stage or cohort whose dependencies
        // are settled; the reason is the same for the whole batch because the
        // batch is one evaluation of one snapshot.
        launch_reason: "dependency_satisfied", actor: "core", decided_at,
      });
    if (!decided.ok) {
      const failure = decided.error;
      const kind = failure.kind === "owner_not_found" || failure.kind === "run_not_found" ? "run_not_found"
        : failure.kind === "version_conflict" ? "version_conflict"
          : failure.kind === "invalid_effect" ? "invalid_effect" : "contradiction";
      return err({ operation: "decide_run", run_id, kind, detail: JSON.stringify(failure) });
    }
    const current = await runVersion(this.sql, run_id);
    if (!current) return err({ operation: "decide_run", run_id, kind: "run_not_found", detail: `workflow run '${run_id}' was deleted mid-decision` });
    return ok({
      run_id, status: current.status, record_version: Number(current.record_version) as RunRecordVersion,
      outcome: current.outcome as RunDecision["outcome"],
      transitions: decided.value.transitions.map((transition): CommittedRunTransition => ({
        transition_id: transition.transition_id, owner: transition.owner, effect: transition.effect_descriptor,
        effect_workflow_id: transition.effect_workflow_id, resulting_owner_version: transition.resulting_owner_version,
      })),
    });
  }

  /* ---------------------------- cohorts ---------------------------- */

  async open_stage_cohorts(input: OpenStageCohorts): Promise<OpenStageCohortsResult> {
    const transition_ids: RunTransitionId[] = [];
    const result = await this.sql.transaction(async (tx) => {
      const stages = await tx.query<{ readonly id: string; readonly status: CoreStatus; readonly stage_contract: JsonValue }>(
        "SELECT id::text,status,stage_contract FROM oakridge.stage_instance WHERE id=$1 AND run_id=$2 FOR UPDATE", [input.stage_instance_id, input.run_id]);
      if (!stages[0]) return { kind: "stage_not_found" as const, detail: `stage instance '${input.stage_instance_id}' was not found in run '${input.run_id}'` };
      if (stages[0].status !== "active") return { kind: "stage_not_active" as const, detail: `stage instance '${input.stage_instance_id}' is ${stages[0].status}` };
      const machine = (stages[0].stage_contract as { readonly machine?: { readonly initial?: string } }).machine;
      const initial = machine?.initial ?? "pending";
      let inserted = 0;
      for (const cohort of input.cohorts) {
        const rows = await tx.query<{ readonly id: string }>(
          `INSERT INTO oakridge.cohort (id,run_id,stage_instance_id,cohort_key,state,depends_on,stage_data,created_at)
           VALUES ($1,$2,$3,$4,$5,$6::text[],$7::jsonb,$8::timestamptz)
           ON CONFLICT (run_id,stage_instance_id,cohort_key) DO NOTHING RETURNING id::text`,
          [cohort.id, input.run_id, input.stage_instance_id, cohort.cohort_key, initial,
            cohort.depends_on ?? [], JSON.stringify(cohort.stage_data), input.opened_at]);
        inserted += rows.length;
      }
      const stored = await tx.query<{ readonly id: string }>(
        "SELECT id::text FROM oakridge.cohort WHERE stage_instance_id=$1 ORDER BY cohort_key", [input.stage_instance_id]);
      if (machine && this.stage_event_applier) {
        const schedulable = await tx.query<{ readonly id: string; readonly cohort_key: string;
          readonly status: CoreStatus; readonly depends_on: readonly string[] }>(
          `SELECT id::text,cohort_key,status,depends_on FROM oakridge.cohort
           WHERE stage_instance_id=$1 ORDER BY cohort_key`, [input.stage_instance_id]);
        const contract = stages[0].stage_contract as { readonly materialization?: { readonly max_parallel?: number } };
        const max_parallel = contract.materialization?.max_parallel ?? 1;
        const selected = new Set(selectStartableCohorts(schedulable.map((cohort) => ({
          cohort_key: cohort.cohort_key, state_status: cohort.status, depends_on: cohort.depends_on,
        })), max_parallel));
        const visited = new Set<CohortId>();
        for (const cohort of schedulable) {
          if (!selected.has(cohort.cohort_key)) continue;
          const started = await this.stage_event_applier.apply_in(tx, cohort.id as CohortId,
            { kind: "started" }, transition_ids, visited);
          if (!started.ok || started.value.kind === "refused") throw new Error(`start cohort '${cohort.cohort_key}' failed: ${JSON.stringify(started)}`);
        }
      }
      return { kind: inserted > 0 ? "opened" as const : "already_open" as const,
        cohort_ids: stored.map((row) => row.id as CohortId) };
    });
    return result;
  }

  async fail_stage_roster(stage_instance_id: StageInstanceId, detail: string, failed_at: string): Promise<void> {
    const rows = await this.sql.query<{ readonly run_id: string; readonly durable_version: string; readonly status: CoreStatus }>(
      "SELECT run_id::text,durable_version::text,status FROM oakridge.stage_instance WHERE id=$1", [stage_instance_id]);
    const stage = rows[0];
    if (!stage) throw new Error(`stage instance '${stage_instance_id}' was not found`);
    if (stage.status === "failed") return;
    const committed = await this.writer.commit({
      run_id: stage.run_id as WorkflowRunId, owner: { kind: "stage_instance", id: stage_instance_id },
      expected_version: Number(stage.durable_version), launch_reason: "recovery",
      change: { status: "failed", blocked_reason: null, next_actor: null,
        outcome: { kind: "failed", code: "roster_failed", detail } },
      effect: { kind: "none" }, actor: "core", changed_at: failed_at,
    });
    if (!committed.ok) throw new Error(`stage roster failure commit: ${committed.error.kind}`);
  }

  async record_cohort_event(input: RecordCohortEvent): Promise<RecordCohortEventResult> {
    const committed = await this.writer.commit({
      run_id: input.run_id, owner: { kind: "cohort", id: input.cohort_id },
      expected_version: input.expected_version, launch_reason: input.launch_reason,
      change: input.change, effect: input.effect, cohort_stage_data: input.stage_data,
      actor: input.actor, changed_at: input.recorded_at,
    });
    if (!committed.ok) {
      const kind = committed.error.kind === "owner_not_found" ? "cohort_not_found"
        : committed.error.kind === "version_conflict" ? "version_conflict" : "invalid_effect";
      if (committed.error.kind === "owner_terminal") return { kind: "owner_terminal", detail: JSON.stringify(committed.error) };
      return { kind, detail: JSON.stringify(committed.error) };
    }
    return { kind: "recorded", transition: {
      transition_id: committed.value.transition_id, owner: committed.value.owner,
      effect: committed.value.effect_descriptor, effect_workflow_id: committed.value.effect_workflow_id,
      resulting_owner_version: committed.value.resulting_owner_version,
    } };
  }

  async find_cohort_state(cohort_id: CohortId): Promise<CohortMachineState | null> {
    return this.sql.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", []);
    const rows = await tx.query<CohortVersionRow>(
      `SELECT ${COHORT_STATE_COLUMNS} FROM oakridge.cohort cohort
       JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id WHERE cohort.id=$1`, [cohort_id]);
    const row = rows[0];
    if (!row) return null;
    const accepted_outputs = await this.listAcceptedCohortOutputs(tx, cohort_id);
    const waits = await this.listCohortWaits(tx, cohort_id);
    const assessmentIds = [...accepted_outputs.filter((artifact) => artifact.artifact_type === "dev.assessment")
      .map((artifact) => artifact.artifact_id), ...waits.open.filter((wait) => wait.output_name === "assessment")
      .flatMap((wait) => wait.artifact_id === null ? [] : [wait.artifact_id])];
    const assessmentRows = assessmentIds.length > 0
      ? await tx.query<{ readonly published_at: string | null }>(
        "SELECT max(created_at)::text AS published_at FROM oakridge.artifact WHERE id=ANY($1::uuid[])", [assessmentIds]) : [];
    const attempts = await tx.query<{ readonly attempt_count: string; readonly open_attempt_id: string | null }>(
        `SELECT count(*)::text AS attempt_count,
                (SELECT open.id::text FROM oakridge.attempt open
                  WHERE open.cohort_id=$1 AND open.ended_at IS NULL
                  ORDER BY open.attempt_number DESC LIMIT 1) AS open_attempt_id
         FROM oakridge.attempt WHERE cohort_id=$1`, [cohort_id]);
    const latest = await tx.query<{ readonly attempt_id: string; readonly attempt_number: number;
      readonly status: CoreStatus; readonly created_at: string; readonly ended_at: string | null }>(
      `SELECT id::text AS attempt_id,attempt_number,status,created_at::text,ended_at::text
       FROM oakridge.attempt WHERE cohort_id=$1 ORDER BY attempt_number DESC LIMIT 1`, [cohort_id]);
    return {
      run_id: row.run_id as WorkflowRunId, stage_instance_id: row.stage_instance_id as StageInstanceId,
      stage_key: row.stage_key, cohort_id: row.id as CohortId, cohort_key: row.cohort_key, status: row.status,
      blocked_reason: row.blocked_reason, next_actor: row.next_actor,
      durable_version: Number(row.durable_version), stage_data: row.stage_data,
      attempt_count: Number(attempts[0]?.attempt_count ?? 0),
      latest_unfinished_attempt_id: (attempts[0]?.open_attempt_id ?? null) as AttemptId | null,
      latest_attempt: latest[0] ? { ...latest[0], attempt_id: latest[0].attempt_id as AttemptId } : null,
      latest_assessment_published_at: assessmentRows[0]?.published_at ?? null,
      accepted_outputs, open_waits: waits.open, decided_gates: waits.decided,
    };
    });
  }

  /**
   * The cohort's waits, split into what it is still parked on and what has been
   * decided.
   *
   * `accepted` is read from `artifact_acceptance` rather than inferred from the
   * action name: whether a decision let the artifact through is a fact about the
   * slot, and the driver should not have to re-derive the disposition core has
   * already applied.
   */
  private async listCohortWaits(sql: SqlExecutor, cohort_id: CohortId): Promise<{
    readonly open: CohortMachineState["open_waits"]; readonly decided: readonly DecidedCohortGate[];
  }> {
    const rows = await sql.query<{
      readonly wait_id: string; readonly kind: "gate" | "handoff" | "external"; readonly status: "open" | "closed" | "cancelled";
      readonly output_name: string | null; readonly action: string | null; readonly artifact_id: string | null;
      readonly accepted: boolean; readonly closed_at: string | null; readonly artifact_body: JsonValue | null;
    }>(
      `SELECT wait.id::text AS wait_id,wait.kind,wait.status,slot.output_name,wait.outcome->>'action' AS action,
              link.artifact_id::text,artifact.body AS artifact_body,
              COALESCE(EXISTS (SELECT 1 FROM oakridge.artifact_acceptance acceptance
                WHERE acceptance.artifact_id=link.artifact_id),false) AS accepted,
              wait.closed_at::text AS closed_at
       FROM oakridge.wait_gate wait
       LEFT JOIN LATERAL (
         SELECT candidate.output_name FROM oakridge.wait_gate_output_slot candidate
         WHERE candidate.wait_gate_id=wait.id ORDER BY candidate.output_name LIMIT 1
       ) slot ON true
       LEFT JOIN LATERAL (
         SELECT candidate.artifact_id FROM oakridge.wait_gate_artifact_revision candidate
         WHERE candidate.wait_gate_id=wait.id ORDER BY candidate.artifact_id LIMIT 1
       ) link ON true
       LEFT JOIN oakridge.artifact artifact ON artifact.id=link.artifact_id
       WHERE wait.cohort_id=$1 ORDER BY wait.opened_at,wait.id`, [cohort_id]);
    return {
      // The parked revision travels with the open wait: it is the cohort's
      // *published* artifact, and publication — not acceptance — is what moves a
      // machine into the review the wait is holding.
      open: rows.filter((row) => row.status === "open")
        .map((row) => ({ wait_id: row.wait_id as WaitId, kind: row.kind, output_name: row.output_name,
          artifact_id: row.artifact_id as ArtifactId | null, artifact_body: row.artifact_body })),
      decided: rows.filter((row) => row.status === "closed" && row.kind === "gate" && row.action !== null)
        .map((row) => ({ wait_id: row.wait_id as WaitId, output_name: row.output_name,
          action: row.action as string, artifact_id: row.artifact_id as ArtifactId | null,
          accepted: row.accepted, decided_at: row.closed_at ?? "" })),
    };
  }

  private async listAcceptedCohortOutputs(sql: SqlExecutor, cohort_id: CohortId): Promise<readonly ArtifactEnvelope[]> {
    const rows = await sql.query<{
      readonly artifact_id: string; readonly artifact_type: string; readonly output_name: string;
      readonly unit_id: string; readonly collection_key: string | null; readonly body: JsonValue; readonly chain_id: string;
    }>(
      `SELECT artifact.id::text AS artifact_id,artifact.artifact_type,acceptance.output_name,
              cohort.cohort_key AS unit_id,acceptance.collection_key,artifact.body,artifact.chain_id::text
       FROM oakridge.artifact_acceptance acceptance
       JOIN oakridge.artifact artifact ON artifact.id=acceptance.artifact_id
       JOIN oakridge.artifact_owner owner ON owner.artifact_id=artifact.id
       JOIN oakridge.cohort cohort ON cohort.id=owner.cohort_id
       WHERE owner.cohort_id=$1 AND artifact.lifecycle IN ('current','released')
       ORDER BY acceptance.output_name,artifact.revision DESC`, [cohort_id]);
    return rows.map((row) => ({ artifact_id: row.artifact_id as ArtifactId, artifact_type: row.artifact_type,
      output_name: row.output_name, unit_id: row.unit_id as UnitId, collection_key: row.collection_key,
      body: row.body, chain_id: row.chain_id as ArtifactId }));
  }

  async list_stage_cohort_ids(stage_instance_id: StageInstanceId): Promise<readonly CohortId[]> {
    const rows = await this.sql.query<{ readonly id: string }>(
      "SELECT id::text FROM oakridge.cohort WHERE stage_instance_id=$1 ORDER BY cohort_key", [stage_instance_id]);
    return rows.map((row) => row.id as CohortId);
  }

  /* ----------------------- attempts and sessions ----------------------- */

  async commit_cohort_launch(input: CommitCohortLaunch): Promise<Result<CohortLaunchCommitted, CohortLaunchCommitError>> {
    return this.sql.transaction(async (tx) => {
      const cohorts = await tx.query<{ readonly id: string; readonly durable_version: string }>(
        "SELECT id::text,durable_version::text FROM oakridge.cohort WHERE id=$1 AND run_id=$2 FOR UPDATE",
        [input.event.cohort_id, input.event.run_id]);
      if (!cohorts[0]) return err({ kind: "cohort_not_found" as const, detail: `cohort '${input.event.cohort_id}' was not found` });
      if (input.attempt.idempotency_key !== null) {
        const claimed = await tx.query<{ readonly id: string }>(
          "SELECT id::text FROM oakridge.attempt WHERE cohort_id=$1 AND idempotency_key=$2",
          [input.event.cohort_id, input.attempt.idempotency_key]);
        if (claimed[0]) return ok({ kind: "already_created" as const, attempt_id: claimed[0].id as AttemptId,
          durable_version: Number(cohorts[0].durable_version) });
      }
      const committed = await this.writer.commit_in(tx, {
        run_id: input.event.run_id, owner: { kind: "cohort", id: input.event.cohort_id },
        expected_version: input.event.expected_version, launch_reason: input.event.launch_reason,
        change: input.event.change, effect: input.event.effect, cohort_stage_data: input.event.stage_data,
        actor: input.event.actor, changed_at: input.event.recorded_at,
      });
      if (!committed.ok) return err({
        kind: committed.error.kind === "owner_not_found" ? "cohort_not_found" : committed.error.kind,
        detail: JSON.stringify(committed.error),
      });
      if (input.event.reopen_output_names.length > 0) {
        await tx.query(
          `UPDATE oakridge.artifact SET lifecycle='superseded'
           WHERE lifecycle='released' AND id IN (
             SELECT acceptance.artifact_id FROM oakridge.artifact_acceptance acceptance
             WHERE acceptance.cohort_id=$1 AND acceptance.output_name=ANY($2)
               AND acceptance.superseded_at IS NULL)`,
          [input.event.cohort_id, input.event.reopen_output_names]);
        await tx.query(
          `UPDATE oakridge.artifact_acceptance SET superseded_at=clock_timestamp()
           WHERE cohort_id=$1 AND output_name=ANY($2) AND superseded_at IS NULL`,
          [input.event.cohort_id, input.event.reopen_output_names]);
      }
      await abandonCohortAttempts(tx, { cohort_id: input.event.cohort_id, at: input.event.recorded_at,
        reason: "replaced by cohort launch" });
      const started = await this.startAttemptIn(tx, { ...input.attempt,
        launch_transition_id: committed.value.transition_id });
      if (started.kind === "cohort_not_found" || started.kind === "idempotency_conflict") {
        throw new Error(`cohort launch attempt insert failed: ${started.detail}`);
      }
      return ok({ kind: "created" as const, attempt_id: started.attempt_id,
        durable_version: committed.value.resulting_owner_version, transition: {
        transition_id: committed.value.transition_id, owner: committed.value.owner,
        effect: committed.value.effect_descriptor, effect_workflow_id: committed.value.effect_workflow_id,
        resulting_owner_version: committed.value.resulting_owner_version,
      } });
    });
  }

  async start_attempt(input: StartAttempt): Promise<StartAttemptResult> {
    return this.sql.transaction((tx) => this.startAttemptIn(tx, input));
  }

  private async startAttemptIn(tx: SqlExecutor, input: StartAttempt): Promise<StartAttemptResult> {
      const cohorts = await tx.query<{ readonly id: string }>(
        "SELECT id::text FROM oakridge.cohort WHERE id=$1 AND run_id=$2 FOR UPDATE", [input.cohort_id, input.run_id]);
      if (!cohorts[0]) return { kind: "cohort_not_found" as const, detail: `cohort '${input.cohort_id}' was not found in run '${input.run_id}'` };
      if (input.idempotency_key !== null) {
        const claimed = await tx.query<{ readonly id: string; readonly attempt_number: number }>(
          "SELECT id::text,attempt_number FROM oakridge.attempt WHERE cohort_id=$1 AND idempotency_key=$2",
          [input.cohort_id, input.idempotency_key]);
        const existing = claimed[0];
        if (existing && existing.id !== input.attempt_id) {
          return { kind: "idempotency_conflict" as const,
            detail: `Idempotency-Key was already used for attempt ${existing.attempt_number} of this cohort` };
        }
      }
      const inserted = await tx.query<{ readonly id: string }>(
        `INSERT INTO oakridge.attempt (id,run_id,stage_instance_id,cohort_id,attempt_number,adapter_type,request,idempotency_key,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::timestamptz)
         ON CONFLICT (cohort_id,attempt_number) DO NOTHING RETURNING id::text`,
        [input.attempt_id, input.run_id, input.stage_instance_id, input.cohort_id, input.attempt_number,
          input.adapter_type, JSON.stringify(input.request), input.idempotency_key, input.created_at]);
      await tx.query(
        `INSERT INTO oakridge.session (id,run_id,stage_instance_id,attempt_id,launch_transition_id,adapter_reference,created_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)
         ON CONFLICT (attempt_id) DO NOTHING`,
        [input.session_id, input.run_id, input.stage_instance_id, input.attempt_id, input.launch_transition_id,
          JSON.stringify({ kind: "none" }), input.created_at]);
      const stored = await tx.query<{ readonly id: string }>(
        "SELECT id::text FROM oakridge.session WHERE attempt_id=$1", [input.attempt_id]);
      const session_id = (stored[0]?.id ?? input.session_id) as SessionId;
      return { kind: inserted.length > 0 ? "started" as const : "already_started" as const,
        attempt_id: input.attempt_id, session_id };
  }

  async find_attempt_execution(attempt_id: AttemptId): Promise<AttemptExecution | null> {
    const rows = await this.sql.query<AttemptRow>(`SELECT ${ATTEMPT_COLUMNS} ${ATTEMPT_SOURCE} WHERE attempt.id=$1`, [attempt_id]);
    return rows[0] ? attemptExecution(rows[0]) : null;
  }

  async bind_session(input: BindSession): Promise<BindSessionResult> {
    return this.sql.transaction(async (tx) => {
      await tx.query(
        `UPDATE oakridge.session SET adapter_reference=$2::jsonb,
           kbbl_session_id=COALESCE($3,kbbl_session_id),updated_at=clock_timestamp() WHERE id=$1`,
        [input.session_id, JSON.stringify(input.adapter_reference), input.kbbl_session_id]);
      const written = await writeSessionStatus(tx, { session_id: input.session_id, status: "active", at: input.bound_at });
      return written.kind === "written" ? { kind: "bound" } : { kind: "attempt_ended", status: written.status };
    });
  }

  async observe_session(input: ObserveSession): Promise<SessionStatusWrite> {
    return this.sql.transaction((tx) => writeSessionStatus(tx,
      { session_id: input.session_id, status: statusFromHealth(input.health), at: input.observed_at }));
  }

  async mark_session_fenced(session_id: SessionId, fenced_at: string): Promise<void> {
    await this.sql.query("UPDATE oakridge.session SET fenced_at=$2::timestamptz,updated_at=clock_timestamp() WHERE id=$1",
      [session_id, fenced_at]);
  }

  async list_prior_sessions_to_fence(cohort_id: CohortId, attempt_id: AttemptId): Promise<readonly import("../domain/run-record").PriorSessionToFence[]> {
    const rows = await this.sql.query<{ readonly session_id: string; readonly attempt_id: string;
      readonly adapter_reference: import("../domain/execution").ExternalExecutionReference }>(
      `SELECT session.id::text AS session_id,session.attempt_id::text,session.adapter_reference
       FROM oakridge.session session
       JOIN oakridge.attempt attempt ON attempt.id=session.attempt_id
       WHERE attempt.cohort_id=$1 AND session.attempt_id<>$2
         AND session.kbbl_session_id IS NOT NULL AND session.fenced_at IS NULL
       ORDER BY attempt.attempt_number`, [cohort_id, attempt_id]);
    return rows.map((row) => ({ session_id: row.session_id as SessionId,
      attempt_id: row.attempt_id as AttemptId, adapter_reference: row.adapter_reference }));
  }

  async find_cohort_retry_claim(cohort_id: CohortId, idempotency_key: string): Promise<{
    readonly attempt_id: AttemptId; readonly attempt_number: number; readonly durable_version: number } | null> {
    const rows = await this.sql.query<{ readonly attempt_id: string; readonly attempt_number: number;
      readonly durable_version: string }>(
      `SELECT attempt.id::text AS attempt_id,attempt.attempt_number,cohort.durable_version::text
       FROM oakridge.attempt attempt JOIN oakridge.cohort cohort ON cohort.id=attempt.cohort_id
       WHERE attempt.cohort_id=$1 AND attempt.idempotency_key=$2`, [cohort_id, idempotency_key]);
    const row = rows[0];
    return row ? { attempt_id: row.attempt_id as AttemptId, attempt_number: row.attempt_number,
      durable_version: Number(row.durable_version) } : null;
  }

  async load_work_order_capability_seed(): Promise<string> {
    const rows = await this.sql.query<{ readonly value: string }>(
      "SELECT value FROM oakridge.runtime_secret WHERE name=$1", [CAPABILITY_SECRET]);
    const row = rows[0];
    if (!row) throw new Error(`runtime secret '${CAPABILITY_SECRET}' is missing; the baseline seeds it`);
    return row.value;
  }

  /* ------------------------ artifacts and waits ------------------------ */

  /**
   * Records an artifact under its attempt's capability and applies its declared
   * release policy in the same transaction.
   *
   * The capability is re-derived from the durable seed and the attempt id rather
   * than compared against a stored hash — the same derivation the resolver used
   * to issue it, so there is no second copy for the two to disagree about, and a
   * capability issued to one attempt can never authenticate another.
   */
  async publish_artifact(request: PublishWorkOrderArtifact): Promise<PublishWorkOrderArtifactResult> {
    return this.publishStageArtifact(request);
  }

  private async publishStageArtifact(request: PublishWorkOrderArtifact): Promise<PublishWorkOrderArtifactResult> {
    const applier = this.stage_event_applier;
    if (!applier) throw new Error("stage event ingress is not configured");
    const seed = await this.load_work_order_capability_seed();
    const expected = capabilityHash(capabilityFor(seed, request.attempt_id as unknown as import("../domain/primitives").WorkOrderId));
    const transition_ids: RunTransitionId[] = [];
    try {
      const result = await this.sql.transaction(async (tx): Promise<PublishWorkOrderArtifactResult> => {
        const rows = await tx.query<{ readonly run_id: string; readonly cohort_id: string;
          readonly stage_instance_id: string; readonly stage_contract: JsonValue; readonly status: CoreStatus;
          readonly session_id: string | null; readonly record_version: string;
          readonly effect_descriptor: JsonValue | null }>(
          `SELECT attempt.run_id::text,attempt.cohort_id::text,attempt.stage_instance_id::text,
                  stage.stage_contract,attempt.status,session.id::text AS session_id,
                  run.record_version::text,launch.effect_descriptor
           FROM oakridge.attempt attempt JOIN oakridge.cohort cohort ON cohort.id=attempt.cohort_id
           JOIN oakridge.stage_instance stage ON stage.id=attempt.stage_instance_id
           JOIN oakridge.workflow_run run ON run.id=attempt.run_id
           LEFT JOIN oakridge.session session ON session.attempt_id=attempt.id
           LEFT JOIN oakridge.run_transition launch ON launch.id=session.launch_transition_id
           WHERE attempt.id=$1 FOR UPDATE OF cohort,attempt`, [request.attempt_id]);
        const attempt = rows[0];
        if (!attempt) return { kind: "work_not_found", detail: `attempt '${request.attempt_id}' was not found` };
        if (request.capability_hash !== expected) return { kind: "invalid_capability", detail: "work-order capability is invalid" };
        if (attempt.status === "cancelled") return { kind: "work_abandoned", detail: "attempt was cancelled" };
        if (attempt.status === "failed") return { kind: "work_not_active", detail: "attempt has failed" };
        const declared = findDeclaredOutput(attempt.stage_contract, request.output_name);
        if (!declared) return { kind: "slot_not_found", detail: `stage does not declare output '${request.output_name}'` };
        const contract = attempt.stage_contract as unknown as import("../domain/compiled-workflow").CompiledStageContract;
        if (contract.stage_type === "delegated_session") {
          const descriptor = attempt.effect_descriptor;
          const launch = isObject(descriptor) && Array.isArray(descriptor.effects)
            ? descriptor.effects.find((effect) => isObject(effect) && effect.name === "launch_session") : null;
          const role = isObject(launch) && isObject(launch.args) && typeof launch.args.role === "string" ? launch.args.role : null;
          const config = contract.executor.definition_config as import("../domain/delegated-session").DelegatedSessionDefinitionConfig;
          const allowed = config.role_configs.find((candidate) => candidate.session_role === role)?.authorized_outputs ?? [];
          if (!allowed.includes(request.output_name)) return { kind: "slot_not_found",
            detail: `session role '${role}' cannot publish '${request.output_name}'` };
        }
        const cohort_id = attempt.cohort_id as CohortId;
        const run_id = attempt.run_id as WorkflowRunId;
        const record_version = Number(attempt.record_version) as RunRecordVersion;
        const collection_key = request.collection_key ?? null;
        const replay = await tx.query<{ readonly id: string; readonly same_body: boolean }>(
          `SELECT artifact.id::text,artifact.body=$4::jsonb AS same_body
           FROM oakridge.cohort_output output
           JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id
           JOIN oakridge.artifact_provenance provenance ON provenance.artifact_id=artifact.id
           WHERE provenance.attempt_id=$1 AND output.output_name=$2
             AND output.collection_key IS NOT DISTINCT FROM $3
           ORDER BY output.round DESC LIMIT 1`,
          [request.attempt_id, request.output_name, collection_key, JSON.stringify(request.body)]);
        if (replay[0]) return replay[0].same_body
          ? { kind: "already_applied", artifact_id: replay[0].id as ArtifactId, run_id, cohort_id, record_version }
          : { kind: "idempotency_conflict", artifact_id: replay[0].id as ArtifactId,
            detail: "this attempt already published a different body into that output" };
        const tips = await tx.query<{ readonly id: string; readonly chain_id: string; readonly revision: number }>(
          `SELECT artifact.id::text,artifact.chain_id::text,artifact.revision
           FROM oakridge.cohort_output output JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id
           WHERE output.cohort_id=$1 AND output.output_name=$2
             AND output.collection_key IS NOT DISTINCT FROM $3
           ORDER BY output.round DESC,artifact.revision DESC LIMIT 1`, [cohort_id, request.output_name, collection_key]);
        const tip = tips[0];
        if (tip) await tx.query("UPDATE oakridge.artifact SET lifecycle='superseded' WHERE id=$1 AND lifecycle='current'", [tip.id]);
        await tx.query(
          `INSERT INTO oakridge.artifact (id,chain_id,revision,parent_artifact_id,artifact_type,body,label,created_at)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,NULL,$7::timestamptz)`,
          [request.artifact_id, tip?.chain_id ?? request.artifact_id, (tip?.revision ?? 0) + 1,
            tip?.id ?? null, declared.artifact_type, JSON.stringify(request.body), request.published_at]);
        await tx.query(
          "INSERT INTO oakridge.artifact_owner (artifact_id,run_id,stage_instance_id,cohort_id) VALUES ($1,$2,$3,$4)",
          [request.artifact_id, run_id, attempt.stage_instance_id, cohort_id]);
        await tx.query(
          `INSERT INTO oakridge.artifact_provenance
             (artifact_id,kind,run_id,stage_instance_id,attempt_id,session_id)
           VALUES ($1,'stage_attempt',$2,$3,$4,$5)`,
          [request.artifact_id, run_id, attempt.stage_instance_id, request.attempt_id, attempt.session_id]);
        const applied = await applier.apply_in(tx, cohort_id, { kind: "artifact_published", attempt_id: request.attempt_id,
          output: request.output_name, collection_key, artifact_id: request.artifact_id,
          enrichment: request.enrichment ?? null }, transition_ids);
        if (!applied.ok) throw new PublishAbort("effect_failed", applied.error.detail);
        if (applied.value.kind === "refused") throw new PublishAbort(applied.value.code, applied.value.detail);
        if (applied.value.kind === "ignored") throw new PublishAbort(applied.value.reason, "publication did not advance cohort");
        return { kind: "published", artifact_id: request.artifact_id, run_id, cohort_id, record_version };
      });
      await applier.start_effects(transition_ids);
      return result;
    } catch (error) {
      if (error instanceof PublishAbort) return { kind: "refused", code: error.code, detail: error.detail };
      throw error;
    }
  }

  decide_gate_wait(request: DecideGateWait): Promise<CloseRunOutputWaitResult> {
    return this.decideStageGate(request);
  }

  private async decideStageGate(request: DecideGateWait): Promise<CloseRunOutputWaitResult> {
    const applier = this.stage_event_applier;
    if (!applier) throw new Error("stage event ingress is not configured");
    const transition_ids: RunTransitionId[] = [];
    try {
      const result = await this.sql.transaction(async (tx): Promise<CloseRunOutputWaitResult> => {
        const location = await tx.query<{ readonly cohort_id: string }>(
          "SELECT cohort_id::text FROM oakridge.wait_gate WHERE id=$1", [request.wait_id]);
        if (!location[0]) return { kind: "wait_not_found", detail: "gate not found" };
        await tx.query("SELECT id FROM oakridge.cohort WHERE id=$1 FOR UPDATE", [location[0].cohort_id]);
        const rows = await tx.query<{ readonly id: string; readonly run_id: string; readonly cohort_id: string;
          readonly status: string; readonly closes_on: JsonValue; readonly command_workflow_id: string;
          readonly record_version: string }>(
          `SELECT wait.id::text,wait.run_id::text,wait.cohort_id::text,wait.status,wait.closes_on,
                  wait.command_workflow_id,run.record_version::text
           FROM oakridge.wait_gate wait JOIN oakridge.workflow_run run ON run.id=wait.run_id
           WHERE wait.id=$1 FOR UPDATE OF wait`, [request.wait_id]);
        const gate = rows[0];
        if (!gate) return { kind: "wait_not_found", detail: "gate not found" };
        if (gate.status !== "open") return { kind: "already_decided", code: "already_decided", detail: "gate is already decided" };
        const actions = isObject(gate.closes_on) && Array.isArray(gate.closes_on.actions)
          ? gate.closes_on.actions.filter((action): action is string => typeof action === "string") : [];
        if (!actions.includes(request.action)) return { kind: "invalid_action", code: "invalid_action",
          detail: `gate does not close on '${request.action}'` };
        if (request.action === "request_revision" && !request.detail?.trim()) return { kind: "invalid_feedback",
          code: "invalid_feedback", detail: "request_revision requires feedback" };
        const match = /^v15-gate:[^:]+:(.+):[0-9]+$/.exec(gate.command_workflow_id);
        if (!match?.[1]) throw new Error(`gate '${gate.id}' has no machine gate name`);
        await tx.query(
          `UPDATE oakridge.wait_gate SET status='closed',closed_at=$2::timestamptz,outcome=$3::jsonb
           WHERE id=$1`, [request.wait_id, request.decided_at,
            JSON.stringify({ kind: "decided", action: request.action, actor: request.actor, feedback: request.detail })]);
        const applied = await applier.apply_in(tx, gate.cohort_id as CohortId, {
          kind: "gate_decided", gate_id: request.wait_id as unknown as import("../domain/stage-machine").GateId,
          gate: match[1], action: request.action, actor: request.actor, feedback: request.detail,
        }, transition_ids);
        if (!applied.ok) throw new PublishAbort("effect_failed", applied.error.detail);
        if (applied.value.kind === "refused") throw new PublishAbort(applied.value.code, applied.value.detail);
        return { kind: "decided", run_id: gate.run_id as WorkflowRunId, cohort_id: gate.cohort_id as CohortId,
          record_version: Number(gate.record_version) as RunRecordVersion };
      });
      await applier.start_effects(transition_ids);
      return result;
    } catch (error) {
      if (error instanceof PublishAbort) return { kind: "refused", code: error.code, detail: error.detail };
      throw error;
    }
  }

  async find_cohort_location(stage_instance_id: StageInstanceId, unit_id: UnitId): Promise<{
    readonly run_id: WorkflowRunId; readonly cohort_id: CohortId; readonly status: CoreStatus;
  } | null> {
    const rows = await this.sql.query<{ readonly run_id: string; readonly id: string; readonly status: CoreStatus }>(
      "SELECT run_id::text,id::text,status FROM oakridge.cohort WHERE stage_instance_id=$1 AND cohort_key=$2",
      [stage_instance_id, unit_id]);
    const row = rows[0];
    return row ? { run_id: row.run_id as WorkflowRunId, cohort_id: row.id as CohortId, status: row.status } : null;
  }

  /* ---------------------------- run lifecycle ---------------------------- */

  /**
   * Cancels the run, then its stages and cohorts, each under its own version.
   *
   * The run's own transition commits first and alone, because that is the fact
   * every other surface reads. A crash between it and the owner cancellations
   * leaves a cancelled run with stages still marked active, so the sweep runs on
   * the `already_terminal` path too: re-entry is the recovery, and a version that
   * reports the run terminal before sweeping has none. Fencing the external
   * sessions is the caller's, and is diagnostic cleanup rather than a domain fact.
   */
  async cancel_run(input: CancelRunRecord): Promise<CancelRunRecordResult> {
    if (this.stage_event_applier) return this.cancelStageRun(input);
    const current = await runVersion(this.sql, input.run_id);
    if (!current) return { kind: "run_not_found", detail: `workflow run '${input.run_id}' was not found` };
    const sessions = await this.listSessionsToFence(input.run_id);
    if (current.status === "complete" || current.status === "failed" || current.status === "cancelled") {
      await this.cancelRunOwners(input);
      return { kind: "already_terminal", run_id: input.run_id, status: current.status, sessions_to_fence: sessions };
    }
    const cancelled = await this.writer.commit({
      run_id: input.run_id, owner: { kind: "run", id: input.run_id }, expected_version: Number(current.record_version),
      launch_reason: "operator",
      change: { status: "cancelled", blocked_reason: null, next_actor: null,
        outcome: { kind: "cancelled", reason: input.reason } },
      effect: { kind: "none" }, actor: input.actor, changed_at: input.cancelled_at,
    });
    if (!cancelled.ok) {
      if (cancelled.error.kind === "owner_not_found") {
        return { kind: "run_not_found", detail: `workflow run '${input.run_id}' was not found` };
      }
      // Another writer moved the run between the read and the commit. Its owners
      // still have to be swept — that writer may have been the cancellation that
      // crashed before finishing.
      await this.cancelRunOwners(input);
      return { kind: "already_terminal", run_id: input.run_id, status: "cancelled", sessions_to_fence: sessions };
    }
    await this.cancelRunOwners(input);
    return { kind: "cancelled", run_id: input.run_id,
      record_version: cancelled.value.resulting_owner_version as RunRecordVersion, sessions_to_fence: sessions };
  }

  private async cancelStageRun(input: CancelRunRecord): Promise<CancelRunRecordResult> {
    const applier = this.stage_event_applier;
    if (!applier) throw new Error("stage event ingress is not configured");
    const transition_ids: RunTransitionId[] = [];
    const result = await this.sql.transaction(async (tx): Promise<CancelRunRecordResult> => {
      const cohorts = await tx.query<{ readonly id: string }>(
        `SELECT cohort.id::text FROM oakridge.cohort cohort
         JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
         WHERE cohort.run_id=$1 AND cohort.status NOT IN ('complete','failed','cancelled')
         ORDER BY stage.stage_key,cohort.cohort_key`, [input.run_id]);
      for (const cohort of cohorts) {
        const applied = await applier.apply_in(tx, cohort.id as CohortId,
          { kind: "cancel", actor: input.actor }, transition_ids);
        if (!applied.ok || applied.value.kind === "refused") throw new Error(`cancel cohort ${cohort.id}: ${JSON.stringify(applied)}`);
      }
      const stages = await tx.query<{ readonly id: string; readonly durable_version: string }>(
        `SELECT id::text,durable_version::text FROM oakridge.stage_instance
         WHERE run_id=$1 AND status NOT IN ('complete','failed','cancelled') ORDER BY stage_key FOR UPDATE`, [input.run_id]);
      for (const stage of stages) {
        const changed = await this.writer.commit_in(tx, {
          run_id: input.run_id, owner: { kind: "stage_instance", id: stage.id as StageInstanceId },
          expected_version: Number(stage.durable_version), launch_reason: "operator",
          change: { status: "cancelled", blocked_reason: null, next_actor: null,
            outcome: { kind: "cancelled", reason: input.reason } },
          effect: { kind: "none" }, actor: input.actor, changed_at: input.cancelled_at,
        });
        if (!changed.ok) throw new Error(`cancel stage ${stage.id}: ${changed.error.kind}`);
      }
      const runs = await tx.query<{ readonly record_version: string; readonly status: CoreStatus }>(
        "SELECT record_version::text,status FROM oakridge.workflow_run WHERE id=$1 FOR UPDATE", [input.run_id]);
      const run = runs[0];
      if (!run) return { kind: "run_not_found", detail: `workflow run '${input.run_id}' was not found` };
      if (isTerminalStatus(run.status)) return { kind: "already_terminal", run_id: input.run_id,
        status: run.status as "complete" | "failed" | "cancelled", sessions_to_fence: [] };
      const changed = await this.writer.commit_in(tx, {
        run_id: input.run_id, owner: { kind: "run", id: input.run_id }, expected_version: Number(run.record_version),
        launch_reason: "operator", change: { status: "cancelled", blocked_reason: null, next_actor: null,
          outcome: { kind: "cancelled", reason: input.reason } },
        effect: { kind: "none" }, actor: input.actor, changed_at: input.cancelled_at,
      });
      if (!changed.ok) throw new Error(`cancel run: ${changed.error.kind}`);
      return { kind: "cancelled", run_id: input.run_id,
        record_version: changed.value.resulting_owner_version as RunRecordVersion, sessions_to_fence: [] };
    });
    await applier.start_effects(transition_ids);
    if (result.kind === "cancelled" || result.kind === "already_terminal") return {
      ...result, sessions_to_fence: await this.listSessionsToFence(input.run_id),
    };
    return result;
  }

  private async cancelRunOwners(input: CancelRunRecord): Promise<void> {
    const cohorts = await this.sql.query<{ readonly id: string }>(
      "SELECT id::text FROM oakridge.cohort WHERE run_id=$1 AND ended_at IS NULL", [input.run_id]);
    for (const cohort of cohorts) {
      await this.cancelOwner(input, { kind: "cohort", id: cohort.id as CohortId }, "cohort");
    }
    const stages = await this.sql.query<{ readonly id: string }>(
      "SELECT id::text FROM oakridge.stage_instance WHERE run_id=$1 AND ended_at IS NULL", [input.run_id]);
    for (const stage of stages) {
      await this.cancelOwner(input, { kind: "stage_instance", id: stage.id as StageInstanceId }, "stage_instance");
    }
    await this.sql.transaction(async (tx) => {
      const live = await tx.query<{ readonly cohort_id: string }>(
        "SELECT DISTINCT cohort_id::text FROM oakridge.attempt WHERE run_id=$1 AND ended_at IS NULL", [input.run_id]);
      for (const row of live) {
        await abandonCohortAttempts(tx, { cohort_id: row.cohort_id as CohortId, at: input.cancelled_at, reason: input.reason ?? "run cancelled" });
      }
    });
    await this.sql.query("UPDATE oakridge.wait_gate SET status='cancelled',closed_at=$2::timestamptz,outcome=$3::jsonb WHERE run_id=$1 AND status='open'",
      [input.run_id, input.cancelled_at, JSON.stringify({ kind: "cancelled", action: "run_cancelled", actor: input.actor, detail: input.reason })]);
  }

  /**
   * Cancels one owner under its own version, and refuses to pretend it did when
   * it could not.
   *
   * The commit result used to be discarded, so an owner that lost a version race
   * silently stayed active — the exact state cancellation exists to remove. A
   * conflict is retried against the re-read version: the writer that won is the
   * owner's own machine, and that machine stops as soon as it reads the status
   * written here, so a bounded handful of attempts settles it. Exhausting them is
   * thrown rather than swallowed, because cancellation is re-entrant now and the
   * operator's next attempt finishes the sweep.
   */
  private async cancelOwner(
    input: CancelRunRecord,
    owner: { readonly kind: "cohort"; readonly id: CohortId } | { readonly kind: "stage_instance"; readonly id: StageInstanceId },
    table: "cohort" | "stage_instance",
  ): Promise<void> {
    for (let attempt = 0; attempt < CANCEL_OWNER_ATTEMPTS; attempt += 1) {
      const rows = await this.sql.query<{ readonly durable_version: string }>(
        `SELECT durable_version::text FROM oakridge.${table} WHERE id=$1 AND ended_at IS NULL`, [owner.id]);
      // No row, or already ended: whoever ended it did this owner's work.
      if (!rows[0]) return;
      const committed = await this.writer.commit({
        run_id: input.run_id, owner, expected_version: Number(rows[0].durable_version), launch_reason: "operator",
        change: { status: "cancelled", blocked_reason: null, next_actor: null, outcome: { kind: "cancelled", reason: input.reason } },
        effect: { kind: "none" }, actor: input.actor, changed_at: input.cancelled_at,
      });
      if (committed.ok || committed.error.kind === "owner_not_found" || committed.error.kind === "owner_terminal") return;
      if (committed.error.kind !== "version_conflict") {
        throw new Error(`cancelling ${owner.kind} '${owner.id}' failed: ${JSON.stringify(committed.error)}`);
      }
    }
    throw new Error(`cancelling ${owner.kind} '${owner.id}' lost ${CANCEL_OWNER_ATTEMPTS} version races; cancel the run again`);
  }

  private async listSessionsToFence(run_id: WorkflowRunId): Promise<readonly CancelledRunSession[]> {
    const rows = await this.sql.query<{ readonly session_id: string; readonly attempt_id: string; readonly adapter_type: string; readonly adapter_reference: JsonValue }>(
      `SELECT session.id::text AS session_id,session.attempt_id::text,attempt.adapter_type,session.adapter_reference
       FROM oakridge.session session
       JOIN oakridge.attempt attempt ON attempt.id=session.attempt_id
       WHERE session.run_id=$1 AND session.fenced_at IS NULL`, [run_id]);
    return rows.flatMap((row) => {
      const reference = deliverableReference(row.adapter_reference);
      if (!reference || reference.kind === "none") return [];
      return [{ session_id: row.session_id as SessionId, attempt_id: row.attempt_id as AttemptId,
        executor_type: row.adapter_type, external_reference: reference }];
    });
  }

  /**
   * Deletes a run and everything the run owns.
   *
   * `oakridge.artifact` has no foreign key to the run — ownership lives on
   * `artifact_owner`, which cascades — so deleting the run alone would leave its
   * artifact bodies behind with nothing pointing at them. They are deleted here,
   * before the run, inside the same transaction.
   */
  async delete_run(run_id: WorkflowRunId): Promise<DeleteRunResult> {
    return this.sql.transaction(async (tx): Promise<DeleteRunResult> => {
      const runs = await tx.query<{ readonly status: CoreStatus }>(
        "SELECT status FROM oakridge.workflow_run WHERE id=$1 FOR UPDATE", [run_id]);
      const run = runs[0];
      if (!run) return { kind: "already_deleted", run_id };
      if (run.status === "pending" || run.status === "active" || run.status === "blocked") {
        return { kind: "active_conflict", run_id, detail: `run is ${run.status}; cancel it before deleting` };
      }
      const live = await tx.query<{ readonly session_id: string }>(
        `SELECT session.id::text AS session_id FROM oakridge.session session
         WHERE session.run_id=$1 AND session.fenced_at IS NULL AND session.adapter_reference->>'kind' NOT IN ('none','completed')
         LIMIT 1`, [run_id]);
      if (live[0]) {
        return { kind: "external_execution_conflict", run_id,
          detail: `session '${live[0].session_id}' still holds an external execution` };
      }
      // Deleted in dependency order, explicitly, rather than left to the run's
      // own cascade. Several v15 foreign keys are deliberately RESTRICT — a
      // session names the transition that launched it, a transition names the
      // stage instance it owns, a wait names the artifact it holds — so the
      // cascade from `workflow_run` alone reaches them in an order Postgres
      // refuses. `oakridge.artifact` has no key to the run at all (ownership
      // lives on `artifact_owner`), so its bodies would simply be left behind.
      for (const statement of [
        "DELETE FROM oakridge.session_message WHERE run_id=$1",
        "DELETE FROM oakridge.wait_gate WHERE run_id=$1",
        "DELETE FROM oakridge.artifact WHERE id IN (SELECT artifact_id FROM oakridge.artifact_owner WHERE run_id=$1)",
        "DELETE FROM oakridge.session WHERE run_id=$1",
        "DELETE FROM oakridge.attempt WHERE run_id=$1",
        "DELETE FROM oakridge.run_transition WHERE run_id=$1",
        "DELETE FROM oakridge.cohort WHERE run_id=$1",
        "DELETE FROM oakridge.stage_instance WHERE run_id=$1",
        "DELETE FROM oakridge.workflow_run WHERE id=$1",
      ]) await tx.query(statement, [run_id]);
      return { kind: "deleted", run_id };
    });
  }
}
