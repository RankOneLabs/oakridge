import type { Command, Contradiction, Derivation, StatusChange } from "../decision/commands";
import { derive } from "../decision/derive";
import { transitionEffectWorkflowId, transitionIdFor } from "../decision/ids";
import type { RunSnapshot } from "../decision/snapshot";
import { err, ok, type Result, type RunTransitionId, type SessionId, type WorkflowRunId } from "../domain/primitives";
import type { CoreStatus } from "../domain/records";
import type { JsonValue } from "../domain/primitives";
import type { StateName } from "../domain/stage-machine";
import type { RunTransitionRecord, SessionStatusWrite, TransitionEffectDescriptor, TransitionLaunchReason, TransitionOwner } from "../domain/run-record";
import type { AdapterRegistry } from "../runtime/executor-registry";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";

const CORE_EFFECT_NAMES = new Set(["none", "start_stage", "start_attempt", "deliver_message", "resume_wait", "stage_machine_effects"]);

/** `oakridge.session_status` and `oakridge.attempt_status` share this vocabulary. */
export type SessionLifecycleStatus = CoreStatus;

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

const checkedEffect = (
  registry: AdapterRegistry,
  effect: TransitionEffectDescriptor,
  actor: string,
): Result<TransitionEffectDescriptor, CommitTransitionError> => {
  if (CORE_EFFECT_NAMES.has(effect.kind)) return ok(effect);
  const dispatched = registry.dispatch(effect.kind, effect, actor);
  if (!dispatched.ok) return err({ kind: "invalid_effect", effect_name: effect.kind,
    detail: "detail" in dispatched.error ? dispatched.error.detail : dispatched.error.kind });
  return ok(dispatched.value.effect);
};

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
    parameters.push(input.cohort_stage_data === undefined ? null : JSON.stringify(input.cohort_stage_data));
    parameters.push(input.cohort_state ?? null);
  }
  const stageDataAssignment = input.owner.kind === "cohort"
    ? ",stage_data=COALESCE($9::jsonb,stage_data),state=COALESCE($10::text,state)"
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
  if (rows[0]) return ok(Number(rows[0].version));
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

export const commitTransitionIn = async (tx: SqlExecutor, registry: AdapterRegistry,
  input: CommitTransitionInput): Promise<Result<CommittedTransition, CommitTransitionError>> => {
  const effect = checkedEffect(registry, input.effect, input.actor);
  if (!effect.ok) return effect;
  const version = await updateOwner(tx, input);
  if (!version.ok) return version;
  return ok(await insertTransition(tx, input, effect.value, version.value));
};

/** The only writer for run, stage-instance, and cohort lifecycle status. */
export class PostgresRunRecordWriter {
  constructor(private readonly sql: TransactionalSqlExecutor, private readonly registry: AdapterRegistry) {}

  commit(input: CommitTransitionInput): Promise<Result<CommittedTransition, CommitTransitionError>> {
    return this.sql.transaction((tx) => commitTransitionIn(tx, this.registry, input));
  }

  commit_in(tx: SqlExecutor, input: CommitTransitionInput): Promise<Result<CommittedTransition, CommitTransitionError>> {
    return commitTransitionIn(tx, this.registry, input);
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
        const effects = commits.map((commit) => checkedEffect(this.registry, commit.effect, commit.actor));
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
): Promise<SessionStatusWrite> => {
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
    if (!rows[0]) throw new Error(`session '${input.session_id}' was not found`);
    return { kind: "already_ended", status: rows[0].status };
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
  return { kind: "written" };
};

/** Abandons every unfinished attempt of a cohort — what a retry replaces. */
export const abandonCohortAttempts = async (
  tx: SqlExecutor,
  input: { readonly cohort_id: import("../domain/primitives").CohortId; readonly at: string; readonly reason: string },
): Promise<void> => {
  await tx.query(
    `UPDATE oakridge.session
     SET status='cancelled'::oakridge.session_status,ended_at=$2::timestamptz,updated_at=clock_timestamp()
     WHERE ended_at IS NULL AND attempt_id IN (SELECT id FROM oakridge.attempt WHERE cohort_id=$1 AND ended_at IS NULL)`,
    [input.cohort_id, input.at]);
  await tx.query(
    `UPDATE oakridge.attempt
     SET status='cancelled'::oakridge.attempt_status,ended_at=$2::timestamptz,outcome=$3::jsonb
     WHERE cohort_id=$1 AND ended_at IS NULL`,
    [input.cohort_id, input.at, JSON.stringify({ kind: "cancelled", reason: input.reason })]);
};
