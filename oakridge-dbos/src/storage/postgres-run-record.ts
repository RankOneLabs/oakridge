import type { Command, Contradiction, Derivation, StatusChange } from "../decision/commands";
import { selectStartableCohorts, type SchedulableCohort } from "../decision/schedule-cohorts";
import { derive } from "../decision/derive";
import { transitionEffectWorkflowId, transitionIdFor } from "../decision/ids";
import type { RunSnapshot } from "../decision/snapshot";
import { err, ok, type Result, type RunTransitionId, type SessionId, type WorkflowRunId } from "../domain/primitives";
import type { CoreStatus } from "../domain/records";
import type { JsonValue } from "../domain/primitives";
import type { StateName } from "../domain/primitives";
import type { RunTransitionRecord, SessionStatusWrite, TransitionEffectDescriptor, TransitionLaunchReason, TransitionOwner } from "../domain/run-record";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";
import { attemptIdFor } from "../decision/ids";
import type { AgentSettings, AssessmentResponse, BuildResponse, BriefCollection, InterruptedExecution,
  ProvisionResponse, ReviewResponse,
  V15WorkerKey } from "../domain/dev-flow-v15";
import type { ArtifactId, CohortId, ExecutionId, StageInstanceId } from "../domain/primitives";
import { artifactRefFromRevision, type ArtifactRef } from "../domain/dev-flow-v15";
import type { V15CompiledCohortDefinition, V15ResolvedAction, V15SelectedDecision } from "../decision/stage-machine";
import type { V15Change, V15OperatorRequestEnvelope } from "../domain/dev-flow-v15";

const CORE_EFFECT_NAMES = new Set(["none", "start_stage", "deliver_message", "resume_wait"]);

/** `oakridge.session_status` and `oakridge.attempt_status` share this vocabulary. */
export type SessionLifecycleStatus = CoreStatus;

type SessionWorkerResponse = BuildResponse | AssessmentResponse | ProvisionResponse
  | ReviewResponse<ArtifactRef | BriefCollection>;

interface SessionWorkerOwner {
  readonly id: ExecutionId;
  readonly cohort_id: CohortId;
  readonly worker: V15WorkerKey;
  readonly work: JsonValue | null;
  readonly response: SessionWorkerResponse | null;
  readonly active_execution_id: ExecutionId | null;
  readonly state: string;
  readonly stop_requested_at: string | null;
}

interface SessionWorkerOutput {
  readonly output_name: string;
  readonly collection_key: string | null;
  readonly chain_id: ArtifactId;
  readonly revision: number;
}

type SessionWorkerInterruption =
  | { readonly execution: InterruptedExecution }
  | { readonly work: JsonValue; readonly execution: InterruptedExecution; readonly build_result: ArtifactRef | null; readonly pr_summary: ArtifactRef | null }
  | { readonly work: JsonValue; readonly execution: InterruptedExecution; readonly assessment: ArtifactRef | null }
  | { readonly work: JsonValue; readonly execution: InterruptedExecution; readonly current: ArtifactRef | null | BriefCollection };

interface SessionWorkerInterruptionInput {
  readonly owner: SessionWorkerOwner;
  readonly session_id: SessionId;
  readonly outputs: readonly SessionWorkerOutput[];
}

const hasCompleteSessionWorkerResponse = async (tx: SqlExecutor, owner: SessionWorkerOwner): Promise<boolean> => {
  const { loadStageCohortContext } = await import("./load-stage-cohort");
  const { workerResponseReady } = await import("../decision/stage-machine");
  const rows = await tx.query<{ readonly stage_key: import("../domain/dev-flow-v15").StageKey }>(
    `SELECT stage.stage_key FROM oakridge.cohort cohort JOIN oakridge.stage_instance stage
     ON stage.id=cohort.stage_instance_id WHERE cohort.id=$1`, [owner.cohort_id]);
  if (!rows[0]) return false;
  const snapshot = await loadStageCohortContext(tx, owner.cohort_id, rows[0].stage_key);
  return snapshot.ok && workerResponseReady(snapshot.value, owner.worker);
};

/** Mirrors the v15 retry bindings: build/assessment refs, review current, or provision execution. */
const sessionWorkerInterruption = (input: SessionWorkerInterruptionInput): SessionWorkerInterruption => {
  const { owner, outputs } = input;
  const execution: InterruptedExecution = { execution_id: owner.id, session_id: input.session_id,
    detail: "session ended before the required publication was complete" };
  const ref = (name: string): ArtifactRef | null => {
    const row = outputs.find((candidate) => candidate.output_name === name);
    return row ? artifactRefFromRevision(row) : null;
  };
  const work = owner.work;
  switch (owner.worker) {
    case "provision": return { execution };
    case "build": return { work, execution, build_result: ref("build_result"), pr_summary: ref("pr_summary") };
    case "assessment": return { work, execution, assessment: ref("assessment") };
    case "spec": return { work, execution, current: ref("spec_analysis") };
    case "plan": return { work, execution, current: ref("plan") };
    case "final_integration": return { work, execution, current: ref("pr_summary") };
    case "brief": return { work, execution, current: { members: outputs.flatMap((row) =>
      row.output_name === "briefs" && row.collection_key !== null
        ? [{ cohort_key: row.collection_key as BriefCollection["members"][number]["cohort_key"], ref: artifactRefFromRevision(row) }] : []) } };
  }
};

export interface CommitTransitionInput {
  readonly run_id: WorkflowRunId;
  readonly owner: TransitionOwner;
  readonly expected_version: number;
  readonly launch_reason: TransitionLaunchReason;
  readonly change: StatusChange;
  readonly effect: TransitionEffectDescriptor;
  /** Adapter-owned cohort state committed under the same owner version. */
  readonly cohort_stage_data?: import("../domain/primitives").JsonValue;
  readonly cohort_state?: StateName;
  readonly event?: JsonValue;
  readonly from_state?: StateName | null;
  readonly to_state?: StateName | null;
  readonly actor: string;
  readonly changed_at: string;
}

export type CommitTransitionError =
  | { readonly kind: "owner_not_found"; readonly owner: TransitionOwner }
  | { readonly kind: "version_conflict"; readonly owner: TransitionOwner; readonly expected_version: number; readonly actual_version: number }
  | { readonly kind: "owner_terminal"; readonly owner: TransitionOwner; readonly status: CoreStatus }
  | { readonly kind: "invalid_effect"; readonly effect_name: string; readonly detail: string };

export interface CommittedTransition {
  readonly transition_id: RunTransitionId;
  readonly owner: TransitionOwner;
  readonly prior_owner_version: number;
  readonly resulting_owner_version: number;
  readonly effect_descriptor: TransitionEffectDescriptor;
  readonly effect_workflow_id: string;
}

export interface DecideTransactionInput {
  readonly load_snapshot: (transaction: SqlExecutor) => Promise<Result<RunSnapshot, { readonly kind: "run_not_found"; readonly run_id: WorkflowRunId }>>;
  /** Adapter composition may supply its own pure decision over the locked snapshot. */
  readonly decide_snapshot?: (snapshot: RunSnapshot) => Result<Derivation, Contradiction>;
  readonly launch_reason: TransitionLaunchReason;
  readonly actor: string;
  readonly decided_at: string;
}

export type DecideTransactionError = Contradiction | CommitTransitionError | { readonly kind: "run_not_found"; readonly run_id: WorkflowRunId };
export interface CommittedDecision {
  readonly derivation: Derivation;
  readonly transitions: readonly CommittedTransition[];
}

interface VersionRow { readonly version: string; readonly status: CoreStatus }

const ownerTable = (owner: TransitionOwner): { readonly table: "workflow_run" | "stage_instance" | "cohort"; readonly version_column: "record_version" | "durable_version" } => {
  if (owner.kind === "run") return { table: "workflow_run", version_column: "record_version" };
  if (owner.kind === "stage_instance") return { table: "stage_instance", version_column: "durable_version" };
  return { table: "cohort", version_column: "durable_version" };
};

const checkedEffect = (effect: TransitionEffectDescriptor): Result<TransitionEffectDescriptor, CommitTransitionError> =>
  CORE_EFFECT_NAMES.has(effect.kind) ? ok(effect) : err({ kind: "invalid_effect", effect_name: effect.kind,
    detail: "only typed core ledger effects are supported" });

const updateOwner = async (
  tx: SqlExecutor,
  input: CommitTransitionInput,
): Promise<Result<number, CommitTransitionError>> => {
  const target = ownerTable(input.owner);
  const runPredicate = input.owner.kind === "run" ? "" : " AND run_id=$8";
  const terminalPredicate = input.owner.kind === "run" ? "" : " AND status NOT IN ('complete','failed','cancelled')";
  const parameters = [input.owner.id, input.expected_version, input.change.status, input.change.blocked_reason,
    input.change.next_actor, input.change.outcome === null ? null : JSON.stringify(input.change.outcome), input.changed_at];
  if (input.owner.kind !== "run") parameters.push(input.run_id);
  if (input.owner.kind === "cohort") {
    parameters.push(input.cohort_state ?? (input.change.status === "cancelled" ? "cancelled" : null));
  }
  const stageDataAssignment = input.owner.kind === "cohort"
    ? ",state=COALESCE($9::text,state)"
    : "";
  const rows = await tx.query<VersionRow>(
    `UPDATE oakridge.${target.table}
     SET status=$3::oakridge.core_status,blocked_reason=$4::oakridge.blocked_reason,next_actor=$5::oakridge.next_actor,outcome=$6::jsonb,
         started_at=CASE WHEN $3::oakridge.core_status='active' THEN COALESCE(started_at,$7::timestamptz) ELSE started_at END,
         ended_at=CASE WHEN $3::oakridge.core_status IN ('complete','failed','cancelled') THEN $7::timestamptz ELSE NULL END,
         ${target.version_column}=${target.version_column}+1${stageDataAssignment}
     WHERE id=$1 AND ${target.version_column}=$2${runPredicate}${terminalPredicate}
     RETURNING ${target.version_column}::text AS version,status`,
    parameters,
  );
  if (rows[0]) {
    if (input.owner.kind === "cohort" && input.change.status === "cancelled") {
      // Cancellation's fixed storage meaning revokes publication before its
      // containing stage/run can publish a terminal outcome. Stop IO recovers.
      await tx.query("UPDATE oakridge.cohort_worker SET state='cancelled',active_execution_id=NULL WHERE cohort_id=$1", [input.owner.id]);
      await tx.query("UPDATE oakridge.cohort SET activation_slot=NULL WHERE id=$1", [input.owner.id]);
      await tx.query(`UPDATE oakridge.execution_intent SET stop_requested_at=COALESCE(stop_requested_at,$2::timestamptz),
        status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END WHERE cohort_id=$1`, [input.owner.id, input.changed_at]);
      await tx.query(`UPDATE oakridge.session SET fenced_at=COALESCE(fenced_at,$2::timestamptz)
        WHERE attempt_id IN (SELECT id FROM oakridge.attempt WHERE cohort_id=$1)`, [input.owner.id, input.changed_at]);
    }
    return ok(Number(rows[0].version));
  }
  const current = await tx.query<VersionRow>(
    `SELECT ${target.version_column}::text AS version,status FROM oakridge.${target.table} WHERE id=$1`, [input.owner.id]);
  if (!current[0]) return err({ kind: "owner_not_found", owner: input.owner });
  if (Number(current[0].version) !== input.expected_version) return err({ kind: "version_conflict", owner: input.owner,
    expected_version: input.expected_version, actual_version: Number(current[0].version) });
  return err({ kind: "owner_terminal", owner: input.owner, status: current[0].status });
};

const insertTransition = async (
  tx: SqlExecutor,
  input: CommitTransitionInput,
  effect: TransitionEffectDescriptor,
  resulting_version: number,
): Promise<CommittedTransition> => {
  const transition_id = transitionIdFor(input.owner, resulting_version);
  const effect_workflow_id = transitionEffectWorkflowId(input.owner, resulting_version);
  await tx.query(
    `INSERT INTO oakridge.run_transition
       (id,run_id,owner_kind,owner_run_id,owner_stage_instance_id,owner_cohort_id,launch_reason,
        prior_owner_version,resulting_owner_version,event,from_state,to_state,effect_descriptor,effect_workflow_id,actor,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14,$15,$16::timestamptz)`,
    [transition_id, input.run_id, input.owner.kind,
      input.owner.kind === "run" ? input.owner.id : null,
      input.owner.kind === "stage_instance" ? input.owner.id : null,
      input.owner.kind === "cohort" ? input.owner.id : null,
      input.launch_reason, input.expected_version, resulting_version,
      JSON.stringify(input.event ?? { kind: "derive" }), input.from_state ?? null, input.to_state ?? null,
      JSON.stringify(effect), effect_workflow_id, input.actor, input.changed_at],
  );
  return { transition_id, owner: input.owner, prior_owner_version: input.expected_version,
    resulting_owner_version: resulting_version, effect_descriptor: effect, effect_workflow_id };
};

const transitionInputFor = (command: Command, input: DecideTransactionInput): CommitTransitionInput => {
  if (command.kind === "transition_run") return {
    run_id: command.run_id, owner: { kind: "run", id: command.run_id }, expected_version: command.expected_version,
    launch_reason: input.launch_reason, change: command.change, effect: command.effect, actor: input.actor, changed_at: input.decided_at,
  };
  if (command.kind === "transition_stage") return {
    run_id: command.run_id, owner: { kind: "stage_instance", id: command.stage_instance_id }, expected_version: command.expected_version,
    launch_reason: input.launch_reason, change: command.change, effect: command.effect, actor: input.actor, changed_at: input.decided_at,
  };
  return {
    run_id: command.run_id, owner: { kind: "cohort", id: command.cohort_id }, expected_version: command.expected_version,
    launch_reason: input.launch_reason, change: command.change, effect: command.effect, actor: input.actor, changed_at: input.decided_at,
    ...(command.stage_data === undefined ? {} : { cohort_stage_data: command.stage_data }),
  };
};

class DecisionTransactionAbort extends Error {
  constructor(readonly reason: CommitTransitionError) { super("decision transaction aborted"); }
}

export const commitTransitionIn = async (tx: SqlExecutor,
  input: CommitTransitionInput): Promise<Result<CommittedTransition, CommitTransitionError>> => {
  const effect = checkedEffect(input.effect);
  if (!effect.ok) return effect;
  const version = await updateOwner(tx, input);
  if (!version.ok) return version;
  return ok(await insertTransition(tx, input, effect.value, version.value));
};

/** The only writer for run, stage-instance, and cohort lifecycle status. */
export class PostgresRunRecordWriter {
  constructor(private readonly sql: TransactionalSqlExecutor) {}

  commit(input: CommitTransitionInput): Promise<Result<CommittedTransition, CommitTransitionError>> {
    return this.sql.transaction((tx) => commitTransitionIn(tx, input));
  }

  commit_in(tx: SqlExecutor, input: CommitTransitionInput): Promise<Result<CommittedTransition, CommitTransitionError>> {
    return commitTransitionIn(tx, input);
  }

  /** Load, derive, and apply one whole-run decision under a single transaction. */
  async decide(input: DecideTransactionInput): Promise<Result<CommittedDecision, DecideTransactionError>> {
    try {
      return await this.sql.transaction(async (tx) => {
        const snapshot = await input.load_snapshot(tx);
        if (!snapshot.ok) return snapshot;
        const derivation = (input.decide_snapshot ?? derive)(snapshot.value);
        if (!derivation.ok) return derivation;
        const commits = derivation.value.commands.map((command) => transitionInputFor(command, input));
        const effects = commits.map((commit) => checkedEffect(commit.effect));
        const invalid = effects.find((effect) => !effect.ok);
        if (invalid && !invalid.ok) throw new DecisionTransactionAbort(invalid.error);
        const transitions: CommittedTransition[] = [];
        for (const [index, commit] of commits.entries()) {
          const version = await updateOwner(tx, commit);
          if (!version.ok) throw new DecisionTransactionAbort(version.error);
          const effect = effects[index];
          if (!effect?.ok) throw new Error("validated decision effect is missing");
          transitions.push(await insertTransition(tx, commit, effect.value, version.value));
        }
        return ok({ derivation: derivation.value, transitions });
      });
    } catch (error) {
      if (error instanceof DecisionTransactionAbort) return err(error.reason);
      throw error;
    }
  }
}

/** Decode shape kept local to this boundary for future transition reads. */
export const decodeTransitionRecord = (row: RunTransitionRecord): RunTransitionRecord => row;

/**
 * An attempt's and its session's status, written from what the adapter
 * reported.
 *
 * These live here for the same reason the owner writer does: this module is the
 * one place lifecycle status is written, and `tests/architecture.test.ts`
 * asserts it stays that way. An attempt has no owner version — it is not a
 * decision owner — so it takes no expected-version argument; the session/attempt
 * pair moves together because there is exactly one session per attempt
 * (`oakridge.session UNIQUE (attempt_id)`).
 */
export const writeSessionStatus = async (
  tx: SqlExecutor,
  input: { readonly session_id: SessionId; readonly status: SessionLifecycleStatus; readonly at: string },
): Promise<Result<SessionStatusWrite, { readonly operation: "write_session_status"; readonly session_id: SessionId; readonly kind: "session_not_found" | "storage_failed"; readonly detail: string }>> => {
  try {
  const location = await tx.query<{ readonly stage_instance_id: StageInstanceId; readonly run_id: WorkflowRunId; readonly cohort_id: CohortId }>(
    `SELECT session.stage_instance_id::text,session.run_id::text,attempt.cohort_id::text FROM oakridge.session session
     JOIN oakridge.attempt attempt ON attempt.id=session.attempt_id WHERE session.id=$1`, [input.session_id]);
  if (location[0]) {
    await tx.query("SELECT id FROM oakridge.stage_instance WHERE id=$1 FOR SHARE", [location[0].stage_instance_id]);
    await tx.query("SELECT id FROM oakridge.workflow_run WHERE id=$1 FOR SHARE", [location[0].run_id]);
    await tx.query("SELECT id FROM oakridge.cohort WHERE id=$1 FOR UPDATE", [location[0].cohort_id]);
  }
  const terminal = input.status === "complete" || input.status === "failed" || input.status === "cancelled";
  const sessions = await tx.query<{ readonly attempt_id: string }>(
    `UPDATE oakridge.session
     SET status=$2::oakridge.session_status,
         started_at=CASE WHEN $2::text='active' THEN COALESCE(started_at,$3::timestamptz) ELSE started_at END,
         ended_at=CASE WHEN $4::boolean THEN $3::timestamptz ELSE NULL END,
         updated_at=clock_timestamp()
     WHERE id=$1 AND ended_at IS NULL RETURNING attempt_id::text`, [input.session_id, input.status, input.at, terminal]);
  if (!sessions[0]) {
    const rows = await tx.query<{ readonly status: CoreStatus }>("SELECT status FROM oakridge.session WHERE id=$1", [input.session_id]);
    if (!rows[0]) return err({ operation: "write_session_status", session_id: input.session_id,
      kind: "session_not_found", detail: `session '${input.session_id}' was not found` });
    return ok({ kind: "already_ended", status: rows[0].status });
  }
  await tx.query(
    `UPDATE oakridge.attempt
     SET status=$2::oakridge.attempt_status,
         started_at=CASE WHEN $2::text='active' THEN COALESCE(started_at,$3::timestamptz) ELSE started_at END,
         ended_at=CASE WHEN $4::boolean THEN $3::timestamptz ELSE NULL END,
         outcome=CASE WHEN $4::boolean THEN $5::jsonb ELSE NULL END
     WHERE id=$1 AND ended_at IS NULL`,
    [sessions[0].attempt_id, input.status, input.at, terminal,
      terminal ? JSON.stringify({ kind: input.status === "complete" ? "succeeded" : input.status }) : null]);
  if (terminal) {
    const owners = await tx.query<SessionWorkerOwner>(
      `SELECT intent.id,intent.cohort_id::text,intent.worker,worker.work,worker.response,
         worker.active_execution_id,worker.state,intent.stop_requested_at::text
       FROM oakridge.execution_intent intent JOIN oakridge.cohort_worker worker
         ON worker.cohort_id=intent.cohort_id AND worker.worker=intent.worker
       WHERE intent.attempt_id=$1 FOR UPDATE OF intent,worker`, [sessions[0].attempt_id]);
    const owner = owners[0];
    if (owner && owner.active_execution_id === owner.id && owner.state === "working"
      && owner.stop_requested_at === null && !await hasCompleteSessionWorkerResponse(tx, owner)) {
      const outputs = await tx.query<SessionWorkerOutput>(
        `SELECT output.output_name,output.collection_key,artifact.chain_id::text,artifact.revision
         FROM oakridge.worker_output output JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id
         WHERE output.cohort_id=$1 AND output.worker=$2 ORDER BY output.output_name,output.collection_key`,
        [owner.cohort_id, owner.worker]);
      const interrupted = sessionWorkerInterruption({ owner, session_id: input.session_id, outputs });
      await tx.query("UPDATE oakridge.cohort_worker SET interrupted=$3::jsonb WHERE cohort_id=$1 AND worker=$2",
        [owner.cohort_id, owner.worker, JSON.stringify(interrupted)]);
      await tx.query("UPDATE oakridge.execution_intent SET status='interrupted' WHERE id=$1", [owner.id]);
    }
  }
  return ok({ kind: "written" });
  } catch (cause) {
    return err({ operation: "write_session_status", session_id: input.session_id,
      kind: "storage_failed", detail: String(cause) });
  }
};

/** Abandons unfinished attempts owned by the worker being replaced. */
export const abandonCohortAttempts = async (
  tx: SqlExecutor,
  input: { readonly cohort_id: import("../domain/primitives").CohortId; readonly worker: import("../domain/dev-flow-v15").V15WorkerKey;
    readonly at: string; readonly reason: string },
): Promise<void> => {
  await tx.query(
    `UPDATE oakridge.session
     SET status='cancelled'::oakridge.session_status,ended_at=$2::timestamptz,updated_at=clock_timestamp()
     WHERE ended_at IS NULL AND attempt_id IN (SELECT id FROM oakridge.attempt WHERE cohort_id=$1 AND worker=$3 AND ended_at IS NULL)`,
    [input.cohort_id, input.at, input.worker]);
  await tx.query(
    `UPDATE oakridge.attempt
     SET status='cancelled'::oakridge.attempt_status,ended_at=$2::timestamptz,outcome=$3::jsonb
     WHERE cohort_id=$1 AND worker=$4 AND ended_at IS NULL`,
    [input.cohort_id, input.at, JSON.stringify({ kind: "cancelled", reason: input.reason }), input.worker]);
};

export interface CommitSelectedCohortInput {
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly cohort_id: CohortId;
  readonly selected: Extract<V15SelectedDecision, { readonly kind: "apply" }>;
  readonly request: V15OperatorRequestEnvelope | null;
  readonly definition: V15CompiledCohortDefinition;
  readonly settings: Readonly<Partial<Record<V15WorkerKey, AgentSettings>>>;
  readonly actor: string;
  readonly at: string;
}

export type CommitSelectedCohortError =
  | { readonly kind: "version_conflict"; readonly expected_version: number; readonly actual_version: number }
  | { readonly kind: "owner_stopped" | "capacity_full" | "dependency_incomplete" | "invalid_decision"; readonly detail: string };

export interface CommittedSelectedCohort {
  readonly transition_id: RunTransitionId;
  readonly resulting_version: number;
  readonly execution_ids: readonly ExecutionId[];
}

class SelectedCohortAbort extends Error {
  constructor(readonly reason: CommitSelectedCohortError) { super(reason.kind); }
}

const reviewedTarget = (request: V15OperatorRequestEnvelope | null) => {
  const value = request?.request;
  if (!value) return null;
  return "target" in value ? value.target : "feedback" in value ? value.feedback.target : null;
};

const directlyReviewedWorker = (request: V15OperatorRequestEnvelope | null): V15WorkerKey | null => {
  switch (request?.request.kind) {
    case "request_build_changes": return "build";
    case "discuss_assessment": case "request_implementation_changes": return "assessment";
    case "revise_analysis": return "spec";
    case "revise_plan": return "plan";
    case "revise_briefs": return "brief";
    default: return null;
  }
};

const selectedCoreStatus = (state: string): CoreStatus => {
  if (state === "pending") return "pending";
  if (state === "complete") return "complete";
  if (state === "failed") return "failed";
  if (state === "cancelled") return "cancelled";
  return "active";
};

const applySelectedChange = async (tx: SqlExecutor, input: CommitSelectedCohortInput,
  change: V15Change): Promise<void> => {
  const { cohort_id, request, at } = input;
  switch (change.kind) {
    case "set_worker_state":
      await tx.query("UPDATE oakridge.cohort_worker SET state=$3 WHERE cohort_id=$1 AND worker=$2",
        [cohort_id, change.worker, change.state]);
      return;
    case "set_cohort_state": return;
    case "fence_execution":
      await tx.query(`UPDATE oakridge.execution_intent intent
        SET stop_requested_at=COALESCE(intent.stop_requested_at,$3::timestamptz),
            status=CASE WHEN intent.status='pending' THEN 'cancelled' ELSE intent.status END
        FROM oakridge.cohort_worker worker
        WHERE worker.cohort_id=$1 AND worker.worker=$2 AND intent.id=worker.active_execution_id`,
      [cohort_id, change.worker, at]);
      await tx.query(`UPDATE oakridge.session session SET fenced_at=COALESCE(fenced_at,$3::timestamptz)
        FROM oakridge.execution_intent intent, oakridge.cohort_worker worker
        WHERE worker.cohort_id=$1 AND worker.worker=$2 AND intent.id=worker.active_execution_id
          AND session.id=intent.session_id`, [cohort_id, change.worker, at]);
      return;
    case "accept_outputs": {
      const target = change.worker === "provision" ? { kind: "verified_operation", execution_id:
        (await tx.query<{ readonly active_execution_id: string }>(
          "SELECT active_execution_id FROM oakridge.cohort_worker WHERE cohort_id=$1 AND worker='provision'", [cohort_id]))[0]?.active_execution_id }
        : reviewedTarget(request);
      if (!target) throw new SelectedCohortAbort({ kind: "invalid_decision", detail: "acceptance requires a reviewed target" });
      await tx.query(`UPDATE oakridge.worker_output SET acceptance_state='accepted',reviewed_target=$3::jsonb
        WHERE cohort_id=$1 AND worker=$2`, [cohort_id, change.worker, JSON.stringify(target)]);
      await tx.query(`UPDATE oakridge.artifact artifact SET acceptance_state='accepted'
        FROM oakridge.worker_output output WHERE output.artifact_id=artifact.id AND output.cohort_id=$1 AND output.worker=$2`,
        [cohort_id, change.worker]);
      return;
    }
    case "clear_acceptance": {
      const is_direct = directlyReviewedWorker(request) === change.worker;
      const target = is_direct ? reviewedTarget(request) : null;
      await tx.query(`UPDATE oakridge.worker_output
        SET acceptance_state=$3,reviewed_target=$4::jsonb WHERE cohort_id=$1 AND worker=$2`,
      [cohort_id, change.worker, target ? "changes_requested" : "unreviewed", target ? JSON.stringify(target) : null]);
      await tx.query(`UPDATE oakridge.artifact artifact SET acceptance_state=$3
        FROM oakridge.worker_output output WHERE output.artifact_id=artifact.id AND output.cohort_id=$1 AND output.worker=$2`,
        [cohort_id, change.worker, target ? "changes_requested" : "unreviewed"]);
      return;
    }
    case "capture_accepted_build": {
      const target = request?.request.kind === "accept_build" ? request.request.target : null;
      if (!target) throw new SelectedCohortAbort({ kind: "invalid_decision", detail: "capturing build requires accept_build" });
      const artifacts = await tx.query<{ readonly body: { readonly pr_url?: string } }>(
        `SELECT artifact.body FROM oakridge.worker_output output JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id
         WHERE output.cohort_id=$1 AND output.worker='build' AND output.output_name='pr_summary'`, [cohort_id]);
      const pr_url = artifacts[0]?.body.pr_url;
      if (!pr_url) throw new SelectedCohortAbort({ kind: "invalid_decision", detail: "accepted build has no PR URL" });
      await tx.query("UPDATE oakridge.cohort SET accepted_build=$2::jsonb WHERE id=$1",
        [cohort_id, JSON.stringify({ outputs: target.outputs, head_sha: target.head_sha, pr_url })]);
      return;
    }
    case "clear_accepted_build":
      await tx.query("UPDATE oakridge.cohort SET accepted_build=NULL WHERE id=$1", [cohort_id]);
      return;
  }
};

const actionConfiguration = (definition: V15CompiledCohortDefinition, action: V15ResolvedAction) =>
  definition.workers[action.worker]?.action_points[action.action.action_point];

/** Commits exactly the evaluator's selected writes; it never selects progression. */
export const commitSelectedCohort = async (sql: TransactionalSqlExecutor,
  input: CommitSelectedCohortInput): Promise<Result<CommittedSelectedCohort, CommitSelectedCohortError>> => {
  try {
    return await sql.transaction(async (tx) => {
      const stage = await tx.query<{ readonly status: CoreStatus; readonly stage_key: import("../domain/dev-flow-v15").StageKey; readonly stage_contract: { readonly max_active_cohorts?: number } }>(
        "SELECT status,stage_key,stage_contract FROM oakridge.stage_instance WHERE id=$1 AND run_id=$2 FOR UPDATE",
        [input.stage_instance_id, input.run_id]);
      const run = await tx.query<{ readonly status: CoreStatus }>(
        "SELECT status FROM oakridge.workflow_run WHERE id=$1 FOR SHARE", [input.run_id]);
      if (stage[0]?.status !== "active" || run[0]?.status !== "active")
        throw new SelectedCohortAbort({ kind: "owner_stopped", detail: "run or stage is not active" });
      const current = await tx.query<{ readonly durable_version: string; readonly state: string;
        readonly activation_slot: number | null; readonly depends_on: readonly CohortId[] }>(
        "SELECT durable_version::text,state,activation_slot,depends_on FROM oakridge.cohort WHERE id=$1 AND stage_instance_id=$2 FOR UPDATE",
        [input.cohort_id, input.stage_instance_id]);
      if (!current[0]) throw new SelectedCohortAbort({ kind: "owner_stopped", detail: "cohort was not found" });
      if (["complete", "failed", "cancelled"].includes(current[0].state))
        throw new SelectedCohortAbort({ kind: "owner_stopped", detail: "cohort is terminal" });
      const actual_version = Number(current[0].durable_version);
      if (actual_version !== input.selected.expected_version)
        throw new SelectedCohortAbort({ kind: "version_conflict", expected_version: input.selected.expected_version, actual_version });
      if (input.request && (input.request.cohort_id !== input.cohort_id || input.request.expected_version !== actual_version))
        throw new SelectedCohortAbort({ kind: "invalid_decision", detail: "request does not name this cohort version" });
      if (input.request && stage[0]) {
        const { loadStageCohortContext } = await import("./load-stage-cohort");
        const { isCohortReviewCurrent } = await import("../decision/stage-machine");
        const snapshot = await loadStageCohortContext(tx, input.cohort_id, stage[0].stage_key);
        if (!snapshot.ok || !isCohortReviewCurrent(snapshot.value, input.request.request))
          throw new SelectedCohortAbort({ kind: "invalid_decision", detail: "review target changed before commit" });
      }
      const next_state = input.selected.changes.find((change) => change.kind === "set_cohort_state")?.state ?? current[0].state;
      const membership = await tx.query<SchedulableCohort>(
        `SELECT id::text AS cohort_key,status AS state_status,depends_on FROM oakridge.cohort
         WHERE stage_instance_id=$1 ORDER BY materialization_position,cohort_key`, [input.stage_instance_id]);
      const limit = stage[0]?.stage_contract.max_active_cohorts ?? 4;
      if (current[0].state === "pending" && next_state === "working"
        && !selectStartableCohorts(membership, limit).includes(input.cohort_id)) {
        const prerequisites_complete = current[0].depends_on.every((id) =>
          membership.some((cohort) => cohort.cohort_key === id && cohort.state_status === "complete"));
        throw new SelectedCohortAbort(prerequisites_complete
          ? { kind: "capacity_full", detail: "four cohorts already hold stage slots" }
          : { kind: "dependency_incomplete", detail: "cohort prerequisites are not complete" });
      }
      let slot = current[0].activation_slot;
      if (next_state === "working" || next_state === "awaiting_merge") {
        if (slot === null) {
          const occupied = await tx.query<{ readonly activation_slot: number }>(
            "SELECT activation_slot FROM oakridge.cohort WHERE stage_instance_id=$1 AND activation_slot IS NOT NULL",
            [input.stage_instance_id]);
          slot = [1, 2, 3, 4].slice(0, limit).find((candidate) => !occupied.some((row) => row.activation_slot === candidate)) ?? null;
          if (slot === null) throw new SelectedCohortAbort({ kind: "capacity_full", detail: "four cohorts already hold stage slots" });
        }
      } else slot = null;
      const status = selectedCoreStatus(next_state);
      await tx.query(`UPDATE oakridge.cohort SET state=$2,status=$3::oakridge.core_status,
        activation_slot=$4,durable_version=durable_version+1,
        started_at=CASE WHEN $3='active' THEN COALESCE(started_at,$5::timestamptz) ELSE started_at END,
        ended_at=CASE WHEN $3 IN ('complete','failed','cancelled') THEN $5::timestamptz ELSE NULL END
        WHERE id=$1`, [input.cohort_id, next_state, status, slot, input.at]);
      const owner: TransitionOwner = { kind: "cohort", id: input.cohort_id };
      const resulting_version = actual_version + 1;
      const transition_id = transitionIdFor(owner, resulting_version);
      await tx.query(`INSERT INTO oakridge.run_transition
        (id,run_id,owner_kind,owner_cohort_id,launch_reason,prior_owner_version,resulting_owner_version,
         event,from_state,to_state,effect_descriptor,effect_workflow_id,actor,created_at)
        VALUES ($1,$2,'cohort',$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11,$12,$13::timestamptz)`,
      [transition_id, input.run_id, input.cohort_id, input.request ? "operator" : "recovery", actual_version,
        resulting_version, JSON.stringify(input.request?.request ?? { kind: "automatic" }), current[0].state, next_state,
        JSON.stringify({ kind: "selected_decision", changes: input.selected.changes, actions: input.selected.actions.map((action) => ({ worker: action.worker, action_point: action.action.action_point })) }), transitionEffectWorkflowId(owner, resulting_version), input.actor, input.at]);
      if (input.request) await tx.query(`INSERT INTO oakridge.cohort_request_receipt
        (request_id,cohort_id,prior_version,resulting_version,request,decision,created_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::timestamptz)`,
      [input.request.id, input.cohort_id, actual_version, resulting_version,
        JSON.stringify(input.request.request), JSON.stringify(input.selected), input.at]);
      for (const worker of Object.keys(input.definition.workers)) await tx.query(
        "INSERT INTO oakridge.cohort_worker (cohort_id,worker) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [input.cohort_id, worker]);
      for (const change of input.selected.changes) await applySelectedChange(tx, input, change);
      const execution_ids: ExecutionId[] = [];
      for (const action of input.selected.actions) {
        const rows = await tx.query<{ readonly attempt_number: number }>(
          `SELECT COALESCE(MAX(attempt_number),0)+1 AS attempt_number FROM oakridge.attempt
           WHERE cohort_id=$1 AND worker=$2`, [input.cohort_id, action.worker]);
        const attempt_id = attemptIdFor(input.cohort_id, rows[0]?.attempt_number ?? 1, action.worker as V15WorkerKey);
        const execution_id = `v15:${attempt_id}` as ExecutionId;
        const configured = actionConfiguration(input.definition, action);
        const settings = input.settings[action.worker];
        if (!configured || action.worker !== "provision" && (!configured.prompt || !settings))
          throw new SelectedCohortAbort({ kind: "invalid_decision", detail: `missing configuration for ${action.worker}` });
        await tx.query(`INSERT INTO oakridge.attempt
          (id,run_id,stage_instance_id,cohort_id,worker,attempt_number,adapter_type,request,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$9,$7::jsonb,$8::timestamptz)`,
          [attempt_id, input.run_id, input.stage_instance_id, input.cohort_id, action.worker,
            rows[0]?.attempt_number ?? 1, JSON.stringify(action), input.at,
            action.worker === "provision" ? "provision_repository_refs" : "kbbl"]);
        await tx.query(`INSERT INTO oakridge.execution_intent
          (id,cohort_id,worker,attempt_id,transition_id,action_point,resolved_input,prompt,settings,created_at,operation)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::timestamptz,$11)`,
          [execution_id, input.cohort_id, action.worker, attempt_id, transition_id,
            action.action.action_point, JSON.stringify(action.action.input), configured.prompt ?? null,
            settings ? JSON.stringify(settings) : null, input.at, configured.operation ?? null]);
        await tx.query(`UPDATE oakridge.cohort_worker SET active_execution_id=$3,
          work=$4::jsonb,response=NULL,interrupted=NULL WHERE cohort_id=$1 AND worker=$2`,
          [input.cohort_id, action.worker, execution_id,
            JSON.stringify(action.action.action_point === "retry" && "work" in action.action.input
              ? action.action.input.work : action.action)]);
        execution_ids.push(execution_id);
      }
      return ok({ transition_id, resulting_version, execution_ids });
    });
  } catch (cause) {
    if (cause instanceof SelectedCohortAbort) return err(cause.reason);
    throw cause;
  }
};

interface ClaimedExecutionOwner {
  readonly execution_id: ExecutionId;
  readonly attempt_id: string;
  readonly cohort_id: CohortId;
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly action_point: string;
  readonly resolved_input: JsonValue;
}

export type ClaimedExecutionIntent = ClaimedExecutionOwner & (
  | { readonly worker: "provision"; readonly prompt: null; readonly settings: null; readonly operation: "provision_repository_refs" }
  | { readonly worker: Exclude<V15WorkerKey, "provision">; readonly prompt: string; readonly settings: AgentSettings; readonly operation: null }
);

/** The executor must claim immediately before IO, after cancellation can fence it. */
export const claimExecutionIntent = async (sql: TransactionalSqlExecutor, execution_id: ExecutionId):
  Promise<Result<ClaimedExecutionIntent, { readonly kind: "not_found" | "stopped" | "already_dispatched" }>> =>
  sql.transaction(async (tx) => {
    const rows = await tx.query<{ readonly attempt_id: string; readonly worker: V15WorkerKey;
      readonly cohort_id: CohortId; readonly run_id: WorkflowRunId; readonly stage_instance_id: StageInstanceId; readonly action_point: string;
      readonly resolved_input: JsonValue; readonly prompt: string | null; readonly settings: AgentSettings | null;
      readonly operation: "provision_repository_refs" | null;
      readonly status: string; readonly stop_requested_at: string | null;
      readonly active_execution_id: string | null; readonly run_status: CoreStatus; readonly stage_status: CoreStatus;
      readonly cohort_state: string }>(
      `SELECT intent.attempt_id::text,intent.worker,intent.cohort_id::text,cohort.run_id::text,cohort.stage_instance_id::text,intent.action_point,intent.resolved_input,intent.prompt,intent.settings,intent.operation,
        intent.status,intent.stop_requested_at::text,worker.active_execution_id,
        run.status AS run_status,stage.status AS stage_status,cohort.state AS cohort_state
       FROM oakridge.execution_intent intent
       JOIN oakridge.cohort_worker worker ON worker.cohort_id=intent.cohort_id AND worker.worker=intent.worker
       JOIN oakridge.cohort cohort ON cohort.id=intent.cohort_id
       JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
       JOIN oakridge.workflow_run run ON run.id=cohort.run_id
       WHERE intent.id=$1 FOR UPDATE OF intent`, [execution_id]);
    const row = rows[0];
    if (!row) return err({ kind: "not_found" as const });
    if (row.status !== "dispatching" && (row.stop_requested_at !== null || row.active_execution_id !== execution_id
      || row.run_status !== "active" || row.stage_status !== "active"
      || row.cohort_state === "cancelled" || row.cohort_state === "failed" || row.cohort_state === "complete"
      || row.status === "cancelled" || row.status === "interrupted")) return err({ kind: "stopped" as const });
    if (row.status !== "pending" && row.status !== "dispatching") return err({ kind: "already_dispatched" as const });
    await tx.query("UPDATE oakridge.execution_intent SET status='dispatching' WHERE id=$1", [execution_id]);
    const owner: ClaimedExecutionOwner = { execution_id, attempt_id: row.attempt_id, cohort_id: row.cohort_id,
      run_id: row.run_id, stage_instance_id: row.stage_instance_id, action_point: row.action_point, resolved_input: row.resolved_input };
    if (row.worker === "provision") return ok({ ...owner, worker: "provision" as const,
      prompt: null, settings: null, operation: "provision_repository_refs" as const });
    if (!row.prompt || !row.settings) throw new Error("agent execution intent is missing its pinned prompt or settings");
    return ok({ ...owner, worker: row.worker, prompt: row.prompt, settings: row.settings, operation: null });
  });

export const recordExecutionDispatch = async (sql: TransactionalSqlExecutor, input: {
  readonly execution_id: ExecutionId;
  readonly session_id: SessionId | null;
  readonly kbbl_session_id?: string | null;
  readonly detail: string | null;
  readonly at: string;
}): Promise<void> => sql.transaction(async (tx) => {
  const location = await tx.query<{ readonly run_id: string; readonly stage_instance_id: string }>(
    `SELECT attempt.run_id::text,attempt.stage_instance_id::text
     FROM oakridge.execution_intent intent JOIN oakridge.attempt attempt ON attempt.id=intent.attempt_id
     WHERE intent.id=$1`, [input.execution_id]);
  if (!location[0]) return;
  const stage = await tx.query<{ readonly status: CoreStatus }>(
    "SELECT status FROM oakridge.stage_instance WHERE id=$1 FOR SHARE", [location[0].stage_instance_id]);
  const run = await tx.query<{ readonly status: CoreStatus }>(
    "SELECT status FROM oakridge.workflow_run WHERE id=$1 FOR SHARE", [location[0].run_id]);
  const rows = await tx.query<{ readonly attempt_id: string; readonly transition_id: string;
    readonly status: string; readonly stop_requested_at: string | null; readonly work: JsonValue | null;
    readonly run_id: string; readonly stage_instance_id: string; readonly cohort_id: string;
    readonly worker: string; readonly active_execution_id: string | null }>(
    `SELECT intent.attempt_id::text,intent.transition_id::text,intent.status,intent.stop_requested_at::text,
      worker.work,worker.active_execution_id,attempt.run_id::text,attempt.stage_instance_id::text,intent.cohort_id::text,intent.worker
     FROM oakridge.execution_intent intent JOIN oakridge.attempt attempt ON attempt.id=intent.attempt_id
     JOIN oakridge.cohort_worker worker ON worker.cohort_id=intent.cohort_id AND worker.worker=intent.worker
     WHERE intent.id=$1 FOR UPDATE OF intent`, [input.execution_id]);
  const row = rows[0];
  if (!row || row.status === "dispatched" || row.status === "interrupted" || row.status === "cancelled") return;
  if (row.status !== "dispatching") throw new Error(`execution ${input.execution_id} was not claimed`);
  const has_stopped = row.stop_requested_at !== null || row.active_execution_id !== input.execution_id
    || stage[0]?.status !== "active" || run[0]?.status !== "active";
  if (input.session_id !== null) {
    await tx.query(`INSERT INTO oakridge.session
      (id,run_id,stage_instance_id,attempt_id,launch_transition_id,adapter_reference,status,fenced_at,created_at,ended_at,kbbl_session_id)
      VALUES ($1,$2,$3,$4,$5,$10::jsonb,$6::oakridge.session_status,
        $7::timestamptz,$8::timestamptz,$7::timestamptz,$9)
      ON CONFLICT (attempt_id) DO NOTHING`,
      [input.session_id, row.run_id, row.stage_instance_id, row.attempt_id, row.transition_id,
        has_stopped ? "cancelled" : "active", has_stopped ? input.at : null, input.at, input.kbbl_session_id ?? null,
        JSON.stringify(input.kbbl_session_id ? { kind: "kbbl_session", session_id: input.kbbl_session_id } : { kind: "none" })]);
    await tx.query(`UPDATE oakridge.execution_intent SET status=$3,
      session_id=(SELECT id FROM oakridge.session WHERE attempt_id=$2) WHERE id=$1`,
      [input.execution_id, row.attempt_id, has_stopped ? "interrupted" : "dispatched"]);
  }
  if (input.session_id !== null && !has_stopped) {
    await tx.query("UPDATE oakridge.attempt SET status='active',started_at=COALESCE(started_at,$2::timestamptz) WHERE id=$1",
      [row.attempt_id, input.at]);
  } else {
    if (input.session_id === null) await tx.query(
      "UPDATE oakridge.execution_intent SET status='interrupted' WHERE id=$1", [input.execution_id]);
    await tx.query(`UPDATE oakridge.cohort_worker SET interrupted=$4::jsonb
      WHERE cohort_id=$1 AND worker=$2 AND active_execution_id=$3`,
      [row.cohort_id, row.worker, input.execution_id,
        JSON.stringify({ work: row.work, execution: { execution_id: input.execution_id,
          session_id: input.session_id, detail: input.detail ?? "dispatch stopped" } })]);
    await tx.query(`UPDATE oakridge.attempt SET status='failed',ended_at=$2::timestamptz,
      outcome=$3::jsonb WHERE id=$1 AND ended_at IS NULL`,
      [row.attempt_id, input.at, JSON.stringify({ kind: "dispatch_failed", detail: input.detail })]);
  }
});

export const requestExecutionStop = async (sql: TransactionalSqlExecutor,
  execution_id: ExecutionId, at: string): Promise<void> => sql.transaction(async (tx) => {
  const rows = await tx.query<{ readonly session_id: string | null }>(
    `UPDATE oakridge.execution_intent SET stop_requested_at=COALESCE(stop_requested_at,$2::timestamptz),
      status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END
     WHERE id=$1 RETURNING session_id::text`, [execution_id, at]);
  if (rows[0]?.session_id) await tx.query(
    "UPDATE oakridge.session SET fenced_at=COALESCE(fenced_at,$2::timestamptz) WHERE id=$1",
    [rows[0].session_id, at]);
});

export interface PublishWorkerOutputInput {
  readonly execution_id: ExecutionId;
  readonly artifact_id: ArtifactId;
  readonly output_name: string;
  readonly collection_key: string | null;
  readonly artifact_type: string;
  readonly body: JsonValue;
  readonly expected: ArtifactRef | null;
  readonly at: string;
}

export type PublishWorkerOutputError =
  | { readonly kind: "publication_fenced" | "stale_output" | "execution_not_found"; readonly detail: string };

/** Publication authority belongs to the worker's current, unfenced execution. */
export const publishWorkerOutput = async (sql: TransactionalSqlExecutor, input: PublishWorkerOutputInput):
  Promise<Result<ArtifactRef, PublishWorkerOutputError>> => sql.transaction((tx) => publishWorkerOutputIn(tx, input));

export const publishWorkerOutputIn = async (tx: SqlExecutor, input: PublishWorkerOutputInput):
  Promise<Result<ArtifactRef, PublishWorkerOutputError>> => {
  const locations = await tx.query<{ readonly stage_instance_id: string; readonly run_id: string; readonly cohort_id: string }>(
    `SELECT cohort.stage_instance_id::text,cohort.run_id::text,cohort.id::text AS cohort_id
     FROM oakridge.execution_intent intent JOIN oakridge.cohort cohort ON cohort.id=intent.cohort_id WHERE intent.id=$1`,
    [input.execution_id]);
  if (!locations[0]) return err({ kind: "execution_not_found", detail: `execution ${input.execution_id} was not found` });
  // The writer and cancellation lock owners in this order. Publication cannot
  // race past an owner stop or deadlock by locking the intent first.
  await tx.query("SELECT id FROM oakridge.stage_instance WHERE id=$1 FOR SHARE", [locations[0].stage_instance_id]);
  await tx.query("SELECT id FROM oakridge.workflow_run WHERE id=$1 FOR SHARE", [locations[0].run_id]);
  await tx.query("SELECT id FROM oakridge.cohort WHERE id=$1 FOR UPDATE", [locations[0].cohort_id]);
  const rows = await tx.query<{ readonly cohort_id: string; readonly worker: string; readonly attempt_id: string;
    readonly run_id: string; readonly stage_instance_id: string; readonly session_id: string | null;
    readonly intent_status: string; readonly stop_requested_at: string | null;
    readonly active_execution_id: string | null; readonly stage_status: CoreStatus; readonly run_status: CoreStatus }>(
    `SELECT intent.cohort_id::text,intent.worker,intent.attempt_id::text,attempt.run_id::text,
      attempt.stage_instance_id::text,intent.session_id::text,intent.status AS intent_status,
      intent.stop_requested_at::text,worker.active_execution_id,stage.status AS stage_status,
      run.status AS run_status
     FROM oakridge.execution_intent intent
     JOIN oakridge.attempt attempt ON attempt.id=intent.attempt_id
     JOIN oakridge.cohort_worker worker ON worker.cohort_id=intent.cohort_id AND worker.worker=intent.worker
     JOIN oakridge.stage_instance stage ON stage.id=attempt.stage_instance_id
     JOIN oakridge.workflow_run run ON run.id=attempt.run_id
     WHERE intent.id=$1 FOR UPDATE OF intent,worker`, [input.execution_id]);
  const owner = rows[0];
  if (!owner) return err({ kind: "execution_not_found", detail: `execution ${input.execution_id} was not found` });
  if (owner.active_execution_id !== input.execution_id || owner.stop_requested_at !== null
    || owner.intent_status !== "dispatched" || owner.stage_status !== "active" || owner.run_status !== "active")
    return err({ kind: "publication_fenced", detail: `execution ${input.execution_id} has no publication authority` });
  const current = await tx.query<{ readonly artifact_id: string; readonly chain_id: string; readonly revision: number;
    readonly body: JsonValue }>(
    `SELECT artifact.id::text AS artifact_id,artifact.chain_id::text,artifact.revision,artifact.body
     FROM oakridge.worker_output output JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id
     WHERE output.cohort_id=$1 AND output.worker=$2 AND output.output_name=$3
       AND output.collection_key IS NOT DISTINCT FROM $4`,
    [owner.cohort_id, owner.worker, input.output_name, input.collection_key]);
  const tip = current[0];
  if ((tip === undefined) !== (input.expected === null)
    || tip && (tip.chain_id !== input.expected?.id || tip.revision !== input.expected.version))
    return err({ kind: "stale_output", detail: `${input.output_name} current revision differs from expected` });
  if (tip) await tx.query("UPDATE oakridge.artifact SET lifecycle='superseded' WHERE id=$1", [tip.artifact_id]);
  const chain_id = tip?.chain_id ?? input.artifact_id;
  const revision = (tip?.revision ?? 0) + 1;
  await tx.query(`INSERT INTO oakridge.artifact
    (id,chain_id,revision,parent_artifact_id,artifact_type,body,created_at)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)`,
    [input.artifact_id, chain_id, revision, tip?.artifact_id ?? null,
      input.artifact_type, JSON.stringify(input.body), input.at]);
  await tx.query(`INSERT INTO oakridge.artifact_owner (artifact_id,run_id,stage_instance_id,cohort_id)
    VALUES ($1,$2,$3,$4)`, [input.artifact_id, owner.run_id, owner.stage_instance_id, owner.cohort_id]);
  await tx.query(`INSERT INTO oakridge.artifact_provenance
    (artifact_id,kind,run_id,stage_instance_id,attempt_id,session_id,output_name,collection_key)
    VALUES ($1,'stage_attempt',$2,$3,$4,$5,$6,$7)`,
    [input.artifact_id, owner.run_id, owner.stage_instance_id, owner.attempt_id, owner.session_id, input.output_name, input.collection_key]);
  await tx.query(`INSERT INTO oakridge.worker_output
    (cohort_id,worker,output_name,collection_key,artifact_id,acceptance_state,reviewed_target,recorded_at)
    VALUES ($1,$2,$3,$4,$5,'unreviewed',NULL,$6::timestamptz)
    ON CONFLICT (cohort_id,worker,output_name,collection_key) DO UPDATE SET
      artifact_id=EXCLUDED.artifact_id,acceptance_state='unreviewed',reviewed_target=NULL,recorded_at=EXCLUDED.recorded_at`,
    [owner.cohort_id, owner.worker, input.output_name, input.collection_key, input.artifact_id, input.at]);
  return ok(artifactRefFromRevision({ chain_id: chain_id as ArtifactId, revision }));
};

export interface ProvisionExecutionCompletion { readonly execution_id: ExecutionId; readonly attempt_id: string;
  readonly cohort_id: CohortId; readonly outcome: import("../domain/repository-provisioning").ProvisionOutcome; readonly at: string }
export const finishProvisionExecutionIn = async (tx: SqlExecutor, input: ProvisionExecutionCompletion): Promise<void> => {
  await tx.query("UPDATE oakridge.execution_intent SET operation_outcome=$2::jsonb WHERE id=$1", [input.execution_id, JSON.stringify(input.outcome)]);
  await tx.query("UPDATE oakridge.cohort_worker SET response=$3::jsonb WHERE cohort_id=$1 AND worker='provision' AND active_execution_id=$2",
    [input.cohort_id, input.execution_id, JSON.stringify({ execution_id: input.execution_id, outcome: input.outcome })]);
  await tx.query("UPDATE oakridge.attempt SET status=$2,ended_at=$3::timestamptz,outcome=$4::jsonb WHERE id=$1",
    [input.attempt_id, input.outcome.kind === "succeeded" ? "complete" : "failed", input.at, JSON.stringify(input.outcome)]);
};
export const interruptProvisionExecution = async (sql: TransactionalSqlExecutor, input: {
  readonly intent: ClaimedExecutionIntent; readonly detail: string; readonly at: string;
}): Promise<void> => sql.transaction(async (tx) => {
  const intent = input.intent;
  await tx.query("SELECT id FROM oakridge.stage_instance WHERE id=$1 FOR SHARE", [intent.stage_instance_id]);
  await tx.query("SELECT id FROM oakridge.workflow_run WHERE id=$1 FOR SHARE", [intent.run_id]);
  await tx.query("SELECT id FROM oakridge.cohort WHERE id=$1 FOR UPDATE", [intent.cohort_id]);
  const active = await tx.query<{ readonly id: string }>(`UPDATE oakridge.execution_intent intent SET status='interrupted'
    FROM oakridge.cohort_worker worker,oakridge.cohort cohort,oakridge.stage_instance stage,oakridge.workflow_run run
    WHERE intent.id=$1 AND intent.stop_requested_at IS NULL AND intent.status='dispatching'
      AND worker.cohort_id=intent.cohort_id AND worker.worker='provision' AND worker.active_execution_id=intent.id
      AND cohort.id=intent.cohort_id AND stage.id=cohort.stage_instance_id AND run.id=cohort.run_id
      AND stage.status='active' AND run.status='active' RETURNING intent.id`, [intent.execution_id]);
  if (!active[0]) return;
  await tx.query(`UPDATE oakridge.cohort_worker SET interrupted=$3::jsonb
    WHERE cohort_id=$1 AND worker='provision' AND active_execution_id=$2`,
    [intent.cohort_id, intent.execution_id, JSON.stringify({ execution: { execution_id: intent.execution_id, session_id: null, detail: input.detail } })]);
  await tx.query("UPDATE oakridge.attempt SET status='failed',ended_at=$2::timestamptz,outcome=$3::jsonb WHERE id=$1",
    [intent.attempt_id, input.at, JSON.stringify({ kind: "interrupted", detail: input.detail })]);
});
