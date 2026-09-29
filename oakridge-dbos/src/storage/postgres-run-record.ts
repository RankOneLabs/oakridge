import type { Command, Contradiction, Derivation, StatusChange } from "../decision/commands";
import { derive } from "../decision/derive";
import { transitionEffectWorkflowId, transitionIdFor } from "../decision/ids";
import type { RunSnapshot } from "../decision/snapshot";
import { err, ok, type Result, type RunTransitionId, type WorkflowRunId } from "../domain/primitives";
import type { RunTransitionRecord, TransitionEffectDescriptor, TransitionLaunchReason, TransitionOwner } from "../domain/run-record";
import type { AdapterRegistry } from "../runtime/executor-registry";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";

const CORE_EFFECT_NAMES = new Set(["none", "start_stage", "start_attempt", "deliver_message", "resume_wait"]);

export interface CommitTransitionInput {
  readonly run_id: WorkflowRunId;
  readonly owner: TransitionOwner;
  readonly expected_version: number;
  readonly launch_reason: TransitionLaunchReason;
  readonly change: StatusChange;
  readonly effect: TransitionEffectDescriptor;
  /** Adapter-owned cohort state committed under the same owner version. */
  readonly cohort_stage_data?: import("../domain/primitives").JsonValue;
  readonly actor: string;
  readonly changed_at: string;
}

export type CommitTransitionError =
  | { readonly kind: "owner_not_found"; readonly owner: TransitionOwner }
  | { readonly kind: "version_conflict"; readonly owner: TransitionOwner; readonly expected_version: number; readonly actual_version: number }
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
  readonly load_snapshot: (transaction: SqlExecutor) => Promise<RunSnapshot>;
  readonly launch_reason: TransitionLaunchReason;
  readonly actor: string;
  readonly decided_at: string;
}

export type DecideTransactionError = Contradiction | CommitTransitionError;
export interface CommittedDecision {
  readonly derivation: Derivation;
  readonly transitions: readonly CommittedTransition[];
}

interface VersionRow { readonly version: string }

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
  const parameters = [input.owner.id, input.expected_version, input.change.status, input.change.blocked_reason,
    input.change.next_actor, JSON.stringify(input.change.outcome), input.changed_at];
  if (input.owner.kind !== "run") parameters.push(input.run_id);
  if (input.owner.kind === "cohort") parameters.push(JSON.stringify(input.cohort_stage_data ?? null));
  const stageDataAssignment = input.owner.kind === "cohort"
    ? ",stage_data=COALESCE($9::jsonb,stage_data)"
    : "";
  const rows = await tx.query<VersionRow>(
    `UPDATE oakridge.${target.table}
     SET status=$3::oakridge.core_status,blocked_reason=$4::oakridge.blocked_reason,next_actor=$5::oakridge.next_actor,outcome=$6::jsonb,
         started_at=CASE WHEN $3::oakridge.core_status='active' THEN COALESCE(started_at,$7::timestamptz) ELSE started_at END,
         ended_at=CASE WHEN $3::oakridge.core_status IN ('complete','failed','cancelled') THEN $7::timestamptz ELSE NULL END,
         ${target.version_column}=${target.version_column}+1${stageDataAssignment}
     WHERE id=$1 AND ${target.version_column}=$2${runPredicate}
     RETURNING ${target.version_column}::text AS version`,
    parameters,
  );
  if (rows[0]) return ok(Number(rows[0].version));
  const current = await tx.query<VersionRow>(
    `SELECT ${target.version_column}::text AS version FROM oakridge.${target.table} WHERE id=$1`, [input.owner.id]);
  if (!current[0]) return err({ kind: "owner_not_found", owner: input.owner });
  return err({ kind: "version_conflict", owner: input.owner, expected_version: input.expected_version, actual_version: Number(current[0].version) });
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
        prior_owner_version,resulting_owner_version,effect_descriptor,effect_workflow_id,actor,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::timestamptz)`,
    [transition_id, input.run_id, input.owner.kind,
      input.owner.kind === "run" ? input.owner.id : null,
      input.owner.kind === "stage_instance" ? input.owner.id : null,
      input.owner.kind === "cohort" ? input.owner.id : null,
      input.launch_reason, input.expected_version, resulting_version, JSON.stringify(effect),
      effect_workflow_id, input.actor, input.changed_at],
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

/** The only writer for run, stage-instance, and cohort lifecycle status. */
export class PostgresRunRecordWriter {
  constructor(private readonly sql: TransactionalSqlExecutor, private readonly registry: AdapterRegistry) {}

  commit(input: CommitTransitionInput): Promise<Result<CommittedTransition, CommitTransitionError>> {
    const effect = checkedEffect(this.registry, input.effect, input.actor);
    if (!effect.ok) return Promise.resolve(effect);
    return this.sql.transaction(async (tx) => {
      const version = await updateOwner(tx, input);
      if (!version.ok) return version;
      return ok(await insertTransition(tx, input, effect.value, version.value));
    });
  }

  /** Load, derive, and apply one whole-run decision under a single transaction. */
  async decide(input: DecideTransactionInput): Promise<Result<CommittedDecision, DecideTransactionError>> {
    try {
      return await this.sql.transaction(async (tx) => {
        const derivation = derive(await input.load_snapshot(tx));
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
