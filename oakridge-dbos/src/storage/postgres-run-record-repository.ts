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
import { attemptIdFor, sessionIdFor, waitGateCommandWorkflowId, waitGateIdFor } from "../decision/ids";
import type { RunOwnedCohortHandoff } from "../domain/cohort-pull-request";
import type { ArtifactEnvelope, ExecutionRequest, ExternalExecutionReference } from "../domain/execution";
import { selectArtifactGateDisposition, selectBuiltInGateDisposition } from "../domain/gates";
import { err, ok, type ArtifactId, type AttemptId, type CohortId, type JsonValue, type Result, type RunRecordVersion, type SessionId, type StageInstanceId, type UnitId, type WaitId, type WorkflowRunId } from "../domain/primitives";
import type { BlockedReason, CoreStatus, NextActor } from "../domain/records";
import type { DeleteRunResult } from "../domain/runs";
import { findDeclaredOutput, parseStageContractOutputs, selectWaitClosesOn, selectWaitKind } from "../domain/stage-contract";
import type {
  AttemptExecution,
  BindSession,
  CancelRunRecord,
  CancelRunRecordResult,
  CancelledRunSession,
  CloseRunOutputWaitResult,
  CohortMachineState,
  CommittedRunTransition,
  CompleteHandoffArtifact,
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
  RetryCohort,
  RetryCohortResult,
  RunDecision,
  RunRecordRepositoryError,
  StartAttempt,
  StartAttemptResult,
} from "../domain/run-record";
import { capabilityFor, capabilityHash, rebindWorkOrderPublication, type MissingOutputSlot } from "../runtime/resolve-work-order";
import { loadRunSnapshot, RunSnapshotNotFoundError } from "./load-run-snapshot";
import { abandonCohortAttempts, writeSessionStatus, type PostgresRunRecordWriter } from "./postgres-run-record";
import type { RunRecordRepository } from "./repositories";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";

const CAPABILITY_SECRET = "work_order_capability";

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
  readonly request: JsonValue;
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
  request: row.request as unknown as ExecutionRequest,
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
  constructor(
    private readonly sql: TransactionalSqlExecutor,
    private readonly writer: PostgresRunRecordWriter,
  ) {}

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
    if (!activated.ok && activated.error.kind === "version_conflict") return { kind: "already_initialized", run_id: input.run_id };
    if (!activated.ok) return { kind: "run_not_found", detail: `run '${input.run_id}' could not be activated: ${activated.error.kind}` };
    return { kind: "initialized", run_id: input.run_id };
  }

  async decide_run(run_id: WorkflowRunId, decided_at: string): Promise<Result<RunDecision, RunRecordRepositoryError>> {
    let decided;
    try {
      decided = await this.writer.decide({
        load_snapshot: (tx) => loadRunSnapshot(tx, run_id),
        // Every command `derive` emits is a stage or cohort whose dependencies
        // are settled; the reason is the same for the whole batch because the
        // batch is one evaluation of one snapshot.
        launch_reason: "dependency_satisfied", actor: "core", decided_at,
      });
    } catch (error) {
      if (error instanceof RunSnapshotNotFoundError) {
        return err({ operation: "decide_run", run_id, kind: "run_not_found", detail: error.message });
      }
      throw error;
    }
    if (!decided.ok) {
      const failure = decided.error;
      const kind = failure.kind === "owner_not_found" ? "run_not_found"
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
    return this.sql.transaction(async (tx) => {
      const stages = await tx.query<{ readonly id: string }>(
        "SELECT id::text FROM oakridge.stage_instance WHERE id=$1 AND run_id=$2 FOR UPDATE", [input.stage_instance_id, input.run_id]);
      if (!stages[0]) return { kind: "stage_not_found" as const, detail: `stage instance '${input.stage_instance_id}' was not found in run '${input.run_id}'` };
      let inserted = 0;
      for (const cohort of input.cohorts) {
        const rows = await tx.query<{ readonly id: string }>(
          `INSERT INTO oakridge.cohort (id,run_id,stage_instance_id,cohort_key,stage_data,created_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz)
           ON CONFLICT (run_id,stage_instance_id,cohort_key) DO NOTHING RETURNING id::text`,
          [cohort.id, input.run_id, input.stage_instance_id, cohort.cohort_key, JSON.stringify(cohort.stage_data), input.opened_at]);
        inserted += rows.length;
      }
      const stored = await tx.query<{ readonly id: string }>(
        "SELECT id::text FROM oakridge.cohort WHERE stage_instance_id=$1 ORDER BY cohort_key", [input.stage_instance_id]);
      return { kind: inserted > 0 ? "opened" as const : "already_open" as const,
        cohort_ids: stored.map((row) => row.id as CohortId) };
    });
  }

  async record_cohort_event(input: RecordCohortEvent): Promise<RecordCohortEventResult> {
    const rows = await this.sql.query<{ readonly durable_version: string }>(
      "SELECT durable_version::text FROM oakridge.cohort WHERE id=$1 AND run_id=$2", [input.cohort_id, input.run_id]);
    if (!rows[0]) return { kind: "cohort_not_found", detail: `cohort '${input.cohort_id}' was not found in run '${input.run_id}'` };
    const committed = await this.writer.commit({
      run_id: input.run_id, owner: { kind: "cohort", id: input.cohort_id },
      expected_version: Number(rows[0].durable_version), launch_reason: input.launch_reason,
      change: input.change, effect: input.effect, cohort_stage_data: input.stage_data,
      actor: input.actor, changed_at: input.recorded_at,
    });
    if (!committed.ok) {
      const kind = committed.error.kind === "owner_not_found" ? "cohort_not_found"
        : committed.error.kind === "version_conflict" ? "version_conflict" : "invalid_effect";
      return { kind, detail: JSON.stringify(committed.error) };
    }
    return { kind: "recorded", transition: {
      transition_id: committed.value.transition_id, owner: committed.value.owner,
      effect: committed.value.effect_descriptor, effect_workflow_id: committed.value.effect_workflow_id,
      resulting_owner_version: committed.value.resulting_owner_version,
    } };
  }

  async find_cohort_state(cohort_id: CohortId): Promise<CohortMachineState | null> {
    const rows = await this.sql.query<CohortVersionRow>(
      `SELECT ${COHORT_STATE_COLUMNS} FROM oakridge.cohort cohort
       JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id WHERE cohort.id=$1`, [cohort_id]);
    const row = rows[0];
    if (!row) return null;
    const [accepted_outputs, waits, attempts] = await Promise.all([
      this.listAcceptedCohortOutputs(cohort_id),
      this.listCohortWaits(cohort_id),
      this.sql.query<{ readonly attempt_count: string }>(
        "SELECT count(*)::text AS attempt_count FROM oakridge.attempt WHERE cohort_id=$1", [cohort_id]),
    ]);
    return {
      run_id: row.run_id as WorkflowRunId, stage_instance_id: row.stage_instance_id as StageInstanceId,
      stage_key: row.stage_key, cohort_id: row.id as CohortId, cohort_key: row.cohort_key, status: row.status,
      blocked_reason: row.blocked_reason, next_actor: row.next_actor,
      durable_version: Number(row.durable_version), stage_data: row.stage_data,
      attempt_count: Number(attempts[0]?.attempt_count ?? 0),
      accepted_outputs, open_waits: waits.open, decided_gates: waits.decided,
    };
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
  private async listCohortWaits(cohort_id: CohortId): Promise<{
    readonly open: CohortMachineState["open_waits"]; readonly decided: readonly DecidedCohortGate[];
  }> {
    const rows = await this.sql.query<{
      readonly wait_id: string; readonly kind: "gate" | "handoff" | "external"; readonly status: "open" | "closed" | "cancelled";
      readonly output_name: string | null; readonly action: string | null; readonly artifact_id: string | null;
      readonly accepted: boolean; readonly closed_at: string | null;
    }>(
      `SELECT wait.id::text AS wait_id,wait.kind,wait.status,slot.output_name,wait.outcome->>'action' AS action,
              link.artifact_id::text,
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
       WHERE wait.cohort_id=$1 ORDER BY wait.opened_at,wait.id`, [cohort_id]);
    return {
      open: rows.filter((row) => row.status === "open")
        .map((row) => ({ wait_id: row.wait_id as WaitId, kind: row.kind, output_name: row.output_name })),
      decided: rows.filter((row) => row.status === "closed" && row.kind === "gate" && row.action !== null)
        .map((row) => ({ wait_id: row.wait_id as WaitId, output_name: row.output_name ?? "",
          action: row.action as string, artifact_id: row.artifact_id as ArtifactId | null,
          accepted: row.accepted, decided_at: row.closed_at ?? "" })),
    };
  }

  private async listAcceptedCohortOutputs(cohort_id: CohortId): Promise<readonly ArtifactEnvelope[]> {
    const rows = await this.sql.query<{
      readonly artifact_id: string; readonly artifact_type: string; readonly output_name: string;
      readonly unit_id: string; readonly body: JsonValue; readonly chain_id: string;
    }>(
      `SELECT artifact.id::text AS artifact_id,artifact.artifact_type,acceptance.output_name,
              cohort.cohort_key AS unit_id,artifact.body,artifact.chain_id::text
       FROM oakridge.artifact_acceptance acceptance
       JOIN oakridge.artifact artifact ON artifact.id=acceptance.artifact_id
       JOIN oakridge.artifact_owner owner ON owner.artifact_id=artifact.id
       JOIN oakridge.cohort cohort ON cohort.id=owner.cohort_id
       WHERE owner.cohort_id=$1 AND artifact.lifecycle IN ('current','released')
       ORDER BY acceptance.output_name,artifact.revision DESC`, [cohort_id]);
    return rows.map((row) => ({ artifact_id: row.artifact_id as ArtifactId, artifact_type: row.artifact_type,
      output_name: row.output_name, unit_id: row.unit_id as UnitId, body: row.body, chain_id: row.chain_id as ArtifactId }));
  }

  async list_stage_cohort_ids(stage_instance_id: StageInstanceId): Promise<readonly CohortId[]> {
    const rows = await this.sql.query<{ readonly id: string }>(
      "SELECT id::text FROM oakridge.cohort WHERE stage_instance_id=$1 ORDER BY cohort_key", [stage_instance_id]);
    return rows.map((row) => row.id as CohortId);
  }

  /* ----------------------- attempts and sessions ----------------------- */

  async start_attempt(input: StartAttempt): Promise<StartAttemptResult> {
    return this.sql.transaction(async (tx) => {
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
    });
  }

  async find_attempt_execution(attempt_id: AttemptId): Promise<AttemptExecution | null> {
    const rows = await this.sql.query<AttemptRow>(`SELECT ${ATTEMPT_COLUMNS} ${ATTEMPT_SOURCE} WHERE attempt.id=$1`, [attempt_id]);
    return rows[0] ? attemptExecution(rows[0]) : null;
  }

  async bind_session(input: BindSession): Promise<void> {
    await this.sql.transaction(async (tx) => {
      await tx.query(
        `UPDATE oakridge.session SET adapter_reference=$2::jsonb,
           kbbl_session_id=COALESCE($3,kbbl_session_id) WHERE id=$1`,
        [input.session_id, JSON.stringify(input.adapter_reference), input.kbbl_session_id]);
      await writeSessionStatus(tx, { session_id: input.session_id, status: "active", at: input.bound_at });
    });
  }

  async observe_session(input: ObserveSession): Promise<void> {
    await this.sql.transaction(async (tx) => {
      await writeSessionStatus(tx, { session_id: input.session_id, status: statusFromHealth(input.health), at: input.observed_at });
    });
  }

  /**
   * One further attempt at a cohort, claimed under the operator's own key.
   *
   * The replacement's execution request is rebound from the previous attempt's
   * — same prompt, workdir and inputs, a freshly minted attempt id and
   * publication capability, and `expected_artifacts` narrowed to the outputs the
   * cohort still owes. A key that has already produced an attempt returns that
   * attempt: `Idempotency-Key` exists so a re-submit after a *completed* retry
   * cannot open a second session, which the transition ledger's own uniqueness
   * cannot see because the two calls are at different owner versions.
   */
  async retry_cohort(input: RetryCohort, retried_at: string): Promise<RetryCohortResult> {
    const located = await this.locateCohort(input.target);
    if (!located) return { kind: "cohort_not_found", detail: `no cohort matches ${JSON.stringify(input.target)}` };
    const claimed = await this.sql.query<{ readonly id: string; readonly attempt_number: number }>(
      "SELECT id::text,attempt_number FROM oakridge.attempt WHERE cohort_id=$1 AND idempotency_key=$2",
      [located.cohort_id, input.idempotency_key]);
    if (claimed[0]) {
      return { kind: "already_created", run_id: located.run_id, cohort_id: located.cohort_id,
        attempt_id: claimed[0].id as AttemptId, attempt_number: claimed[0].attempt_number,
        durable_version: located.durable_version };
    }
    if (located.status === "complete" || located.status === "failed" || located.status === "cancelled") {
      return { kind: "not_active", detail: `cohort '${located.cohort_id}' is ${located.status}` };
    }
    const openWaits = await this.sql.query<{ readonly id: string }>(
      "SELECT id::text FROM oakridge.wait_gate WHERE cohort_id=$1 AND status='open' LIMIT 1", [located.cohort_id]);
    if (openWaits[0]) {
      return { kind: "actionable_wait", detail: `cohort '${located.cohort_id}' is waiting on ${openWaits[0].id}; decide it instead of retrying` };
    }
    const latest = await this.sql.query<AttemptRow & { readonly ended_at: string | null }>(
      `SELECT ${ATTEMPT_COLUMNS},attempt.ended_at::text
       ${ATTEMPT_SOURCE} WHERE attempt.cohort_id=$1 ORDER BY attempt.attempt_number DESC LIMIT 1`, [located.cohort_id]);
    const basisRow = latest[0];
    if (!basisRow) return { kind: "not_active", detail: `cohort '${located.cohort_id}' has no attempt to retry from` };
    if (basisRow.ended_at === null && basisRow.status === "active") {
      return { kind: "work_in_progress", detail: `attempt ${basisRow.attempt_number} of cohort '${located.cohort_id}' is still running` };
    }
    const basis = attemptExecution(basisRow);
    const missing = await this.listMissingSlots(located.cohort_id, located.stage_instance_id);
    const attempt_number = basisRow.attempt_number + 1;
    const attempt_id = attemptIdFor(located.cohort_id, attempt_number);
    const rebound = rebindWorkOrderPublication({
      basis: basis.request, work_order_id: attempt_id as unknown as import("../domain/primitives").WorkOrderId,
      capability_seed: await this.load_work_order_capability_seed(), missing,
      ...(basis.adapter_reference && basis.adapter_reference.kind === "kbbl_session"
        ? { retry_workspace_source: { execution_id: basis.request.execution_id, external_reference: basis.adapter_reference } }
        : {}),
    });
    if (!rebound) return { kind: "not_active", detail: `attempt ${basisRow.attempt_number} carries no publication authority to retry from` };
    const committed = await this.writer.commit({
      run_id: located.run_id, owner: { kind: "cohort", id: located.cohort_id },
      expected_version: located.durable_version, launch_reason: "retry",
      change: { status: "active", blocked_reason: null, next_actor: "agent", outcome: null },
      effect: { kind: "start_attempt", cohort_id: located.cohort_id, attempt_id, attempt_number },
      actor: input.actor, changed_at: retried_at,
    });
    if (!committed.ok) {
      return committed.error.kind === "version_conflict"
        ? { kind: "work_in_progress", detail: "the cohort changed while the retry was being admitted; ask again" }
        : { kind: "cohort_not_found", detail: JSON.stringify(committed.error) };
    }
    await this.sql.transaction((tx) => abandonCohortAttempts(tx, { cohort_id: located.cohort_id, at: retried_at, reason: "replaced by operator retry" }));
    const started = await this.start_attempt({
      run_id: located.run_id, stage_instance_id: located.stage_instance_id, cohort_id: located.cohort_id,
      attempt_id, attempt_number, adapter_type: basis.adapter_type, request: rebound.request,
      launch_transition_id: committed.value.transition_id, session_id: sessionIdFor(attempt_id),
      idempotency_key: input.idempotency_key, created_at: retried_at,
    });
    if (started.kind === "idempotency_conflict") return started;
    if (started.kind === "cohort_not_found") return { kind: "cohort_not_found", detail: started.detail };
    return { kind: started.kind === "started" ? "created" : "already_created", run_id: located.run_id,
      cohort_id: located.cohort_id, attempt_id, attempt_number,
      durable_version: committed.value.resulting_owner_version };
  }

  private async locateCohort(target: RetryCohort["target"]): Promise<{
    readonly run_id: WorkflowRunId; readonly cohort_id: CohortId; readonly stage_instance_id: StageInstanceId;
    readonly status: CoreStatus; readonly durable_version: number;
  } | null> {
    const rows = target.kind === "cohort"
      ? await this.sql.query<CohortVersionRow>(`SELECT ${COHORT_STATE_COLUMNS} FROM oakridge.cohort cohort
          JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id WHERE cohort.id=$1`, [target.cohort_id])
      : await this.sql.query<CohortVersionRow>(`SELECT ${COHORT_STATE_COLUMNS} FROM oakridge.cohort cohort
          JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
          WHERE cohort.stage_instance_id=$1 AND cohort.cohort_key=$2`, [target.stage_instance_id, target.cohort_key]);
    const row = rows[0];
    if (!row) return null;
    return { run_id: row.run_id as WorkflowRunId, cohort_id: row.id as CohortId,
      stage_instance_id: row.stage_instance_id as StageInstanceId, status: row.status,
      durable_version: Number(row.durable_version) };
  }

  /** The declared outputs a cohort still owes — no accepted revision in the slot. */
  private async listMissingSlots(cohort_id: CohortId, stage_instance_id: StageInstanceId): Promise<readonly MissingOutputSlot[]> {
    const contracts = await this.sql.query<{ readonly stage_contract: JsonValue }>(
      "SELECT stage_contract FROM oakridge.stage_instance WHERE id=$1", [stage_instance_id]);
    const contract = contracts[0]?.stage_contract;
    if (contract === undefined) return [];
    const accepted = await this.sql.query<{ readonly output_name: string; readonly collection_key: string | null }>(
      `SELECT acceptance.output_name,acceptance.collection_key
       FROM oakridge.artifact_acceptance acceptance
       JOIN oakridge.artifact_owner owner ON owner.artifact_id=acceptance.artifact_id
       WHERE owner.cohort_id=$1`, [cohort_id]);
    const held = new Set(accepted.map((row) => `${row.output_name} ${row.collection_key ?? ""}`));
    return parseStageContractOutputs(contract)
      .filter((output) => !held.has(`${output.output_name} `))
      .map((output) => ({ output_name: output.output_name, collection_key: null }));
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
    const seed = await this.load_work_order_capability_seed();
    const expected = capabilityHash(capabilityFor(seed, request.attempt_id as unknown as import("../domain/primitives").WorkOrderId));
    return this.sql.transaction(async (tx): Promise<PublishWorkOrderArtifactResult> => {
      const attempts = await tx.query<{
        readonly id: string; readonly run_id: string; readonly stage_instance_id: string; readonly cohort_id: string;
        readonly status: CoreStatus; readonly ended_at: string | null; readonly stage_contract: JsonValue;
        readonly session_id: string | null; readonly record_version: string;
      }>(
        `SELECT attempt.id::text,attempt.run_id::text,attempt.stage_instance_id::text,attempt.cohort_id::text,
                attempt.status,attempt.ended_at::text,stage.stage_contract,session.id::text AS session_id,
                run.record_version::text
         FROM oakridge.attempt attempt
         JOIN oakridge.stage_instance stage ON stage.id=attempt.stage_instance_id
         JOIN oakridge.workflow_run run ON run.id=attempt.run_id
         LEFT JOIN oakridge.session session ON session.attempt_id=attempt.id
         WHERE attempt.id=$1 FOR UPDATE OF attempt`, [request.attempt_id]);
      const attempt = attempts[0];
      if (!attempt) return { kind: "work_not_found", detail: `attempt '${request.attempt_id}' was not found` };
      if (request.capability_hash !== expected) return { kind: "invalid_capability", detail: "work-order capability is not valid for this attempt" };
      if (attempt.status === "cancelled") return { kind: "work_abandoned", detail: `attempt '${request.attempt_id}' was cancelled` };
      if (attempt.status === "failed") return { kind: "work_not_active", detail: `attempt '${request.attempt_id}' has failed` };

      const declared = findDeclaredOutput(attempt.stage_contract, request.output_name);
      if (!declared) {
        return { kind: "slot_not_found", detail: `stage does not declare output '${request.output_name}'` };
      }
      const collection_key = request.collection_key ?? null;
      const run_id = attempt.run_id as WorkflowRunId;
      const cohort_id = attempt.cohort_id as CohortId;
      const record_version = Number(attempt.record_version) as RunRecordVersion;

      const replay = await tx.query<{ readonly id: string; readonly same_body: boolean; readonly lifecycle: string; readonly wait_id: string | null }>(
        `SELECT artifact.id::text,artifact.body=$4::jsonb AS same_body,artifact.lifecycle,
                open_wait.id::text AS wait_id
         FROM oakridge.artifact artifact
         JOIN oakridge.artifact_provenance provenance ON provenance.artifact_id=artifact.id
         LEFT JOIN LATERAL (
           SELECT wait.id FROM oakridge.wait_gate wait
           JOIN oakridge.wait_gate_artifact_revision link ON link.wait_gate_id=wait.id
           WHERE link.artifact_id=artifact.id AND wait.status='open' LIMIT 1
         ) open_wait ON true
         WHERE provenance.attempt_id=$1
           AND (
             EXISTS (
               SELECT 1 FROM oakridge.wait_gate_output_slot slot
               JOIN oakridge.wait_gate_artifact_revision link ON link.wait_gate_id=slot.wait_gate_id
               WHERE link.artifact_id=artifact.id AND slot.output_name=$2
                 AND slot.collection_key IS NOT DISTINCT FROM $3
             )
             OR EXISTS (
               SELECT 1 FROM oakridge.artifact_acceptance acceptance
               WHERE acceptance.artifact_id=artifact.id AND acceptance.output_name=$2
                 AND acceptance.collection_key IS NOT DISTINCT FROM $3
             )
           )
         ORDER BY artifact.revision DESC LIMIT 1`,
        [request.attempt_id, request.output_name, collection_key, JSON.stringify(request.body)]);
      const prior = replay[0];
      if (prior) {
        if (!prior.same_body) {
          return { kind: "idempotency_conflict", artifact_id: prior.id as ArtifactId,
            detail: "this attempt already published a different body into that slot" };
        }
        return prior.wait_id
          ? { kind: "pending", artifact_id: prior.id as ArtifactId, wait_id: prior.wait_id as WaitId, run_id, cohort_id, record_version }
          : { kind: "already_applied", artifact_id: prior.id as ArtifactId, run_id, cohort_id, record_version };
      }

      const slotState = await tx.query<{ readonly accepted_id: string | null; readonly pending_wait_id: string | null; readonly chain_id: string | null; readonly revision: number | null; readonly tip_id: string | null }>(
        `SELECT accepted.artifact_id::text AS accepted_id,pending.wait_id::text AS pending_wait_id,
                tip.chain_id::text,tip.revision,tip.id::text AS tip_id
         FROM (SELECT 1) anchor
         LEFT JOIN LATERAL (
           SELECT acceptance.artifact_id FROM oakridge.artifact_acceptance acceptance
           JOIN oakridge.artifact artifact ON artifact.id=acceptance.artifact_id
           WHERE acceptance.receiving_stage_instance_id=$1 AND acceptance.output_name=$2
             AND acceptance.collection_key IS NOT DISTINCT FROM $3
             AND artifact.lifecycle IN ('current','released') LIMIT 1
         ) accepted ON true
         LEFT JOIN LATERAL (
           SELECT slot.wait_gate_id AS wait_id FROM oakridge.wait_gate_output_slot slot
           JOIN oakridge.wait_gate wait ON wait.id=slot.wait_gate_id
           WHERE slot.receiving_stage_instance_id=$1 AND slot.output_name=$2
             AND slot.collection_key IS NOT DISTINCT FROM $3 AND wait.status='open' LIMIT 1
         ) pending ON true
         LEFT JOIN LATERAL (
           SELECT artifact.id,artifact.chain_id,artifact.revision FROM oakridge.artifact artifact
           JOIN oakridge.artifact_owner owner ON owner.artifact_id=artifact.id
           WHERE owner.cohort_id=$4 AND artifact.artifact_type=$5
           ORDER BY artifact.revision DESC,artifact.created_at DESC LIMIT 1
         ) tip ON true`,
        [attempt.stage_instance_id, request.output_name, collection_key, cohort_id, declared.artifact_type]);
      const slot = slotState[0];
      if (slot?.accepted_id) {
        return { kind: "slot_already_released", artifact_id: slot.accepted_id as ArtifactId,
          detail: `output '${request.output_name}' already holds an accepted revision` };
      }
      if (slot?.pending_wait_id) {
        return { kind: "slot_pending", wait_id: slot.pending_wait_id as WaitId,
          detail: `output '${request.output_name}' is parked pending its wait` };
      }

      const parent = slot?.tip_id ?? null;
      const chain_id = slot?.chain_id ?? request.artifact_id;
      const revision = (slot?.revision ?? 0) + 1;
      if (parent) {
        await tx.query("UPDATE oakridge.artifact SET lifecycle='superseded' WHERE id=$1 AND lifecycle='current'", [parent]);
      }
      await tx.query(
        `INSERT INTO oakridge.artifact (id,chain_id,revision,parent_artifact_id,artifact_type,body,label,created_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::timestamptz)`,
        [request.artifact_id, chain_id, revision, parent, declared.artifact_type, JSON.stringify(request.body), null, request.published_at]);
      await tx.query(
        `INSERT INTO oakridge.artifact_owner (artifact_id,run_id,stage_instance_id,cohort_id) VALUES ($1,$2,$3,$4)`,
        [request.artifact_id, run_id, attempt.stage_instance_id, cohort_id]);
      await tx.query(
        `INSERT INTO oakridge.artifact_provenance (artifact_id,kind,run_id,stage_instance_id,attempt_id,session_id)
         VALUES ($1,'stage_attempt',$2,$3,$4,$5)`,
        [request.artifact_id, run_id, attempt.stage_instance_id, request.attempt_id, attempt.session_id]);

      const waitKind = selectWaitKind(declared.release);
      if (waitKind === null) {
        await tx.query(
          `INSERT INTO oakridge.artifact_acceptance (artifact_id,run_id,receiving_stage_instance_id,output_name,artifact_type,collection_key,accepted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz)`,
          [request.artifact_id, run_id, attempt.stage_instance_id, request.output_name, declared.artifact_type, collection_key, request.published_at]);
        return { kind: "published", artifact_id: request.artifact_id, run_id, cohort_id, record_version };
      }
      const wait_id = waitGateIdFor(request.artifact_id);
      await tx.query(
        `INSERT INTO oakridge.wait_gate (id,run_id,stage_instance_id,cohort_id,kind,closes_on,command_workflow_id,opened_at)
         VALUES ($1,$2,$3,$4,$5::oakridge.wait_kind,$6::jsonb,$7,$8::timestamptz)
         ON CONFLICT (id) DO NOTHING`,
        [wait_id, run_id, attempt.stage_instance_id, cohort_id, waitKind,
          JSON.stringify(selectWaitClosesOn(declared.release)), waitGateCommandWorkflowId(request.artifact_id), request.published_at]);
      await tx.query(
        `INSERT INTO oakridge.wait_gate_artifact_revision (wait_gate_id,artifact_id,run_id) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`, [wait_id, request.artifact_id, run_id]);
      await tx.query(
        `INSERT INTO oakridge.wait_gate_output_slot (wait_gate_id,run_id,receiving_stage_instance_id,output_name,collection_key)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [wait_id, run_id, attempt.stage_instance_id, request.output_name, collection_key]);
      return { kind: "pending", artifact_id: request.artifact_id, wait_id, run_id, cohort_id, record_version };
    });
  }

  decide_gate_wait(request: DecideGateWait): Promise<CloseRunOutputWaitResult> {
    return this.closeWait({ wait: { kind: "id", wait_id: request.wait_id }, action: request.action,
      actor: request.actor, detail: request.detail, decided_at: request.decided_at, kinds: ["gate"] });
  }

  complete_handoff_artifact(request: CompleteHandoffArtifact): Promise<CloseRunOutputWaitResult> {
    return this.closeWait({ wait: { kind: "artifact", artifact_id: request.artifact_id }, action: request.external_kind,
      actor: request.actor, detail: request.correlation_id, decided_at: request.decided_at, kinds: ["handoff", "external"] });
  }

  /**
   * Closes one wait and applies what its decision does to the slots it holds,
   * in one transaction: an action whose disposition releases accepts the
   * revision into its slot; one that asks for a revision leaves the revision
   * current and the slot empty, which is what makes the replacement publishable;
   * a terminal one withdraws it.
   *
   * The cohort's own advance is not written here. That is its machine's
   * decision, taken from this wait's recorded outcome under the cohort's own
   * durable version — one owner, one writer.
   */
  private async closeWait(input: {
    readonly wait: { readonly kind: "id"; readonly wait_id: WaitId } | { readonly kind: "artifact"; readonly artifact_id: ArtifactId };
    readonly action: string;
    readonly actor: string;
    readonly detail: string | null;
    readonly decided_at: string;
    readonly kinds: readonly ("gate" | "handoff" | "external")[];
  }): Promise<CloseRunOutputWaitResult> {
    return this.sql.transaction(async (tx): Promise<CloseRunOutputWaitResult> => {
      const predicate = input.wait.kind === "id"
        ? "wait.id=$1"
        : "EXISTS (SELECT 1 FROM oakridge.wait_gate_artifact_revision link WHERE link.wait_gate_id=wait.id AND link.artifact_id=$1)";
      const parameter = input.wait.kind === "id" ? input.wait.wait_id : input.wait.artifact_id;
      const waits = await tx.query<{
        readonly id: string; readonly run_id: string; readonly cohort_id: string | null; readonly status: "open" | "closed" | "cancelled";
        readonly closes_on: JsonValue; readonly outcome: JsonValue | null; readonly record_version: string;
      }>(
        `SELECT wait.id::text,wait.run_id::text,wait.cohort_id::text,wait.status,wait.closes_on,wait.outcome,
                run.record_version::text
         FROM oakridge.wait_gate wait
         JOIN oakridge.workflow_run run ON run.id=wait.run_id
         WHERE ${predicate} AND wait.kind=ANY($2::oakridge.wait_kind[])
         ORDER BY wait.status='open' DESC,wait.opened_at DESC LIMIT 1
         FOR UPDATE OF wait`, [parameter, input.kinds]);
      const wait = waits[0];
      if (!wait) return { kind: "wait_not_found", detail: `no ${input.kinds.join("/")} wait matches ${String(parameter)}` };
      const run_id = wait.run_id as WorkflowRunId;
      const cohort_id = wait.cohort_id as CohortId | null;
      const record_version = Number(wait.record_version) as RunRecordVersion;
      if (wait.status !== "open") {
        const decided = isObject(wait.outcome) && wait.outcome.action === input.action;
        return decided
          ? { kind: "already_applied", run_id, cohort_id, record_version }
          : { kind: "wait_conflict", detail: `wait '${wait.id}' is already ${wait.status}` };
      }
      const declaredActions = isObject(wait.closes_on) && Array.isArray(wait.closes_on.actions)
        ? wait.closes_on.actions.filter((value): value is string => typeof value === "string")
        : [];
      const closeEvents = isObject(wait.closes_on) && Array.isArray(wait.closes_on.close_events)
        ? wait.closes_on.close_events.filter((value): value is string => typeof value === "string")
        : [];
      const externalKind = isObject(wait.closes_on) && typeof wait.closes_on.external_wait_kind === "string"
        ? wait.closes_on.external_wait_kind : null;
      const accepted = input.kinds[0] === "gate"
        ? declaredActions.includes(input.action)
        : input.action === externalKind || closeEvents.includes(input.action) || declaredActions.includes(input.action);
      if (!accepted) {
        return { kind: "wait_conflict", detail: `wait '${wait.id}' does not close on '${input.action}'` };
      }

      const linked = await tx.query<{ readonly artifact_id: string; readonly artifact_type: string }>(
        `SELECT link.artifact_id::text,artifact.artifact_type
         FROM oakridge.wait_gate_artifact_revision link
         JOIN oakridge.artifact artifact ON artifact.id=link.artifact_id
         WHERE link.wait_gate_id=$1 ORDER BY link.artifact_id`, [wait.id]);
      const slots = await tx.query<{ readonly receiving_stage_instance_id: string; readonly output_name: string; readonly collection_key: string | null }>(
        `SELECT receiving_stage_instance_id::text,output_name,collection_key
         FROM oakridge.wait_gate_output_slot WHERE wait_gate_id=$1 ORDER BY output_name,collection_key NULLS FIRST`, [wait.id]);

      const disposition = input.kinds[0] === "gate" ? selectBuiltInGateDisposition(input.action) : "release";
      await tx.query(
        `UPDATE oakridge.wait_gate SET status='closed',closed_at=$2::timestamptz,outcome=$3::jsonb
         WHERE id=$1 AND status='open'`,
        [wait.id, input.decided_at, JSON.stringify({ kind: "decided", action: input.action, actor: input.actor, detail: input.detail })]);

      let releasedArtifactId: ArtifactId | null = null;
      for (const artifact of linked) {
        const effective = input.kinds[0] === "gate"
          ? selectArtifactGateDisposition(artifact.artifact_type, disposition)
          : "release";
        if (effective === "release") {
          for (const slot of slots) {
            await tx.query(
              `INSERT INTO oakridge.artifact_acceptance (artifact_id,run_id,receiving_stage_instance_id,output_name,artifact_type,collection_key,accepted_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz) ON CONFLICT (artifact_id) DO NOTHING`,
              [artifact.artifact_id, run_id, slot.receiving_stage_instance_id, slot.output_name,
                artifact.artifact_type, slot.collection_key, input.decided_at]);
          }
          await tx.query("UPDATE oakridge.artifact SET lifecycle='released' WHERE id=$1 AND lifecycle='current'", [artifact.artifact_id]);
          releasedArtifactId = artifact.artifact_id as ArtifactId;
          continue;
        }
        if (effective === "terminal") {
          await tx.query("UPDATE oakridge.artifact SET lifecycle='withdrawn' WHERE id=$1 AND lifecycle='current'", [artifact.artifact_id]);
        }
        // `revise` leaves the revision `current` and its slot unaccepted: the
        // next attempt publishes the replacement into the same slot, as a new
        // revision of the same chain.
      }
      return releasedArtifactId !== null
        ? { kind: "released", artifact_id: releasedArtifactId, run_id, cohort_id, record_version }
        : { kind: "invalidated", run_id, cohort_id, record_version };
    });
  }

  /**
   * The cohort's handoff output and what state its slot is in — what the
   * pull-request reconciler reads before it closes the external wait.
   */
  async find_cohort_handoff(stage_instance_id: StageInstanceId, unit_id: UnitId): Promise<RunOwnedCohortHandoff | null> {
    const rows = await this.sql.query<{
      readonly run_id: string; readonly cohort_id: string; readonly repository_key: string | null;
      readonly artifact_id: string | null; readonly lifecycle: string | null; readonly open_wait: boolean;
      readonly accepted: boolean; readonly body: JsonValue | null;
    }>(
      `SELECT cohort.run_id::text,cohort.id::text AS cohort_id,build_cohort.repository_key,
              handoff.id::text AS artifact_id,handoff.lifecycle,
              handoff.open_wait,handoff.accepted,handoff.body
       FROM oakridge.cohort cohort
       LEFT JOIN oakridge.dev_flow_build_cohort build_cohort ON build_cohort.cohort_id=cohort.id
       LEFT JOIN LATERAL (
         SELECT artifact.id,artifact.lifecycle,artifact.body,
                EXISTS (SELECT 1 FROM oakridge.wait_gate wait
                  JOIN oakridge.wait_gate_artifact_revision link ON link.wait_gate_id=wait.id
                  WHERE link.artifact_id=artifact.id AND wait.kind IN ('handoff','external') AND wait.status='open') AS open_wait,
                EXISTS (SELECT 1 FROM oakridge.artifact_acceptance acceptance WHERE acceptance.artifact_id=artifact.id) AS accepted
         FROM oakridge.artifact artifact
         JOIN oakridge.artifact_owner owner ON owner.artifact_id=artifact.id
         WHERE owner.cohort_id=cohort.id
           AND EXISTS (SELECT 1 FROM oakridge.wait_gate wait
             JOIN oakridge.wait_gate_artifact_revision link ON link.wait_gate_id=wait.id
             WHERE link.artifact_id=artifact.id AND wait.kind IN ('handoff','external'))
         ORDER BY artifact.revision DESC LIMIT 1
       ) handoff ON true
       WHERE cohort.stage_instance_id=$1 AND cohort.cohort_key=$2`, [stage_instance_id, unit_id]);
    const row = rows[0];
    if (!row || row.artifact_id === null) return null;
    const handoff_slot_state = row.accepted ? "released" as const
      : row.open_wait ? "pending" as const
        : row.lifecycle === "withdrawn" ? "invalidated" as const : "empty" as const;
    return {
      run_id: row.run_id as WorkflowRunId, stage_instance_id, cohort_id: row.cohort_id as CohortId, unit_id,
      repository_key: row.repository_key ?? "", handoff_artifact_id: row.artifact_id as ArtifactId,
      handoff_slot_state, handoff_body: row.body ?? null,
    };
  }

  /* ---------------------------- run lifecycle ---------------------------- */

  /**
   * Cancels the run, then its stages and cohorts, each under its own version.
   *
   * The run's own transition commits first and alone, because that is the fact
   * every other surface reads: a crash between it and the stage cancellations
   * leaves a cancelled run with stages still marked active, and re-running
   * cancellation finishes the job — the already-cancelled run reports
   * `already_terminal` and the remaining owners are transitioned. Fencing the
   * external sessions is the caller's, and is diagnostic cleanup rather than a
   * domain fact.
   */
  async cancel_run(input: CancelRunRecord): Promise<CancelRunRecordResult> {
    const current = await runVersion(this.sql, input.run_id);
    if (!current) return { kind: "run_not_found", detail: `workflow run '${input.run_id}' was not found` };
    if (current.status === "complete" || current.status === "failed" || current.status === "cancelled") {
      return { kind: "already_terminal", run_id: input.run_id, status: current.status };
    }
    const sessions = await this.listSessionsToFence(input.run_id);
    const cancelled = await this.writer.commit({
      run_id: input.run_id, owner: { kind: "run", id: input.run_id }, expected_version: Number(current.record_version),
      launch_reason: "operator",
      change: { status: "cancelled", blocked_reason: null, next_actor: null,
        outcome: { kind: "cancelled", reason: input.reason } },
      effect: { kind: "none" }, actor: input.actor, changed_at: input.cancelled_at,
    });
    if (!cancelled.ok) {
      return cancelled.error.kind === "owner_not_found"
        ? { kind: "run_not_found", detail: `workflow run '${input.run_id}' was not found` }
        : { kind: "already_terminal", run_id: input.run_id, status: "cancelled" };
    }
    await this.cancelRunOwners(input);
    return { kind: "cancelled", run_id: input.run_id,
      record_version: cancelled.value.resulting_owner_version as RunRecordVersion, sessions_to_fence: sessions };
  }

  private async cancelRunOwners(input: CancelRunRecord): Promise<void> {
    const cohorts = await this.sql.query<{ readonly id: string; readonly durable_version: string }>(
      "SELECT id::text,durable_version::text FROM oakridge.cohort WHERE run_id=$1 AND ended_at IS NULL", [input.run_id]);
    for (const cohort of cohorts) {
      await this.writer.commit({
        run_id: input.run_id, owner: { kind: "cohort", id: cohort.id as CohortId },
        expected_version: Number(cohort.durable_version), launch_reason: "operator",
        change: { status: "cancelled", blocked_reason: null, next_actor: null, outcome: { kind: "cancelled", reason: input.reason } },
        effect: { kind: "none" }, actor: input.actor, changed_at: input.cancelled_at,
      });
    }
    const stages = await this.sql.query<{ readonly id: string; readonly durable_version: string }>(
      "SELECT id::text,durable_version::text FROM oakridge.stage_instance WHERE run_id=$1 AND ended_at IS NULL", [input.run_id]);
    for (const stage of stages) {
      await this.writer.commit({
        run_id: input.run_id, owner: { kind: "stage_instance", id: stage.id as StageInstanceId },
        expected_version: Number(stage.durable_version), launch_reason: "operator",
        change: { status: "cancelled", blocked_reason: null, next_actor: null, outcome: { kind: "cancelled", reason: input.reason } },
        effect: { kind: "none" }, actor: input.actor, changed_at: input.cancelled_at,
      });
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

  private async listSessionsToFence(run_id: WorkflowRunId): Promise<readonly CancelledRunSession[]> {
    const rows = await this.sql.query<{ readonly session_id: string; readonly attempt_id: string; readonly adapter_type: string; readonly adapter_reference: JsonValue }>(
      `SELECT session.id::text AS session_id,session.attempt_id::text,attempt.adapter_type,session.adapter_reference
       FROM oakridge.session session
       JOIN oakridge.attempt attempt ON attempt.id=session.attempt_id
       WHERE session.run_id=$1 AND session.ended_at IS NULL`, [run_id]);
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
         WHERE session.run_id=$1 AND session.ended_at IS NULL AND session.adapter_reference->>'kind' NOT IN ('none','completed')
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
