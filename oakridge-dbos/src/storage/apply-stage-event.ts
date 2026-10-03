import { selectStartableCohorts } from "../decision/schedule-cohorts";
import { transition } from "../decision/stage-machine";
import { runStageEffectsIn, type CohortEffectRow, type RegisteredEffect } from "../decision/stage-effects";
import type { StageInputSet } from "../decision/commands";
import { err, ok, type ArtifactId, type AttemptId, type CohortId, type JsonValue, type Result, type RunTransitionId, type StageInstanceId, type WorkflowRunId } from "../domain/primitives";
import { readOwn, type CoreStatus } from "../domain/records";
import type { CompiledStageContract } from "../domain/compiled-workflow";
import type { TransitionLaunchReason } from "../domain/run-record";
import type { CompiledMachine, MachineRegistry, RefusalCode, RoundOutput, StageEvent, StateName } from "../domain/stage-machine";
import { PostgresRunRecordWriter } from "./postgres-run-record";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";

export type ApplyOutcome =
  | { readonly kind: "applied"; readonly transition_id: RunTransitionId; readonly from: StateName; readonly to: StateName }
  | { readonly kind: "ignored"; readonly reason: "cohort_terminal" | "stale_attempt" }
  | { readonly kind: "refused"; readonly code: RefusalCode | "owner_terminal" | "no_transition" | "stale_attempt";
      readonly from: StateName; readonly detail: string };

export interface ApplyStageEventError {
  readonly operation: "apply_stage_event";
  readonly cohort_id: CohortId;
  readonly kind: "cohort_not_found" | "effect_failed";
  readonly detail: string;
}

interface CohortRow {
  readonly id: string;
  readonly run_id: string;
  readonly stage_instance_id: string;
  readonly cohort_key: string;
  readonly state: StateName;
  readonly status: CoreStatus;
  readonly round: number;
  readonly depends_on: readonly string[];
  readonly durable_version: string;
  readonly stage_data: JsonValue;
}

interface OwnerRow { readonly status: CoreStatus; readonly stage_contract?: JsonValue }
interface LatestAttemptRow { readonly id: string }

export interface ApplyStageEventDependencies {
  readonly sql: TransactionalSqlExecutor;
  readonly writer: PostgresRunRecordWriter;
  readonly registry: MachineRegistry;
  readonly registered_effects: ReadonlyMap<string, RegisteredEffect>;
  readonly load_stage_inputs: (tx: SqlExecutor, stage_instance_id: StageInstanceId, cohort_key: string) => Promise<StageInputSet>;
  readonly start_effects: (transition_ids: readonly RunTransitionId[]) => Promise<void>;
  readonly now: () => string;
}

const isTerminal = (status: CoreStatus): boolean => status === "complete" || status === "failed" || status === "cancelled";

const launchReason = (event: StageEvent, depends_on: readonly string[]): TransitionLaunchReason => {
  switch (event.kind) {
    case "started": return depends_on.length > 0 ? "dependency_satisfied" : "initial";
    case "artifact_published": return "artifact_accepted";
    case "gate_decided": return "gate_decided";
    case "session_ended": return "recovery";
    case "operator_retry": return "retry";
    case "operator_abandon": case "cancel": return "operator";
    case "external_observed": return "artifact_accepted";
  }
};

const eventActor = (event: StageEvent): string =>
  event.kind === "gate_decided" || event.kind === "operator_retry" || event.kind === "operator_abandon" || event.kind === "cancel"
    ? event.actor : "core";

const attemptedId = (event: StageEvent): AttemptId | null =>
  event.kind === "artifact_published" || event.kind === "session_ended" ? event.attempt_id : null;

const effectDescriptor = (effects: readonly import("../domain/stage-machine").EffectRef[]): {
  readonly kind: "stage_machine_effects"; readonly effects: JsonValue; readonly external: boolean } => ({
  kind: "stage_machine_effects", effects: effects as unknown as JsonValue,
  external: effects.some((effect) => effect.name === "launch_session" || effect.name === "end_session"),
});

class ApplyAbort extends Error {
  constructor(readonly failure: ApplyStageEventError) { super(failure.detail); }
}

export class StageEventApplier {
  constructor(private readonly dependencies: ApplyStageEventDependencies) {}

  async lock_stage_cohorts_in(tx: SqlExecutor, cohort_id: CohortId): Promise<readonly CohortRow[]> {
    const location = await tx.query<{ readonly stage_instance_id: string }>(
      "SELECT stage_instance_id::text FROM oakridge.cohort WHERE id=$1", [cohort_id]);
    if (!location[0]) return [];
    // All ingress, roster and run operations lock stages before their cohorts.
    await tx.query("SELECT id FROM oakridge.stage_instance WHERE id=$1 FOR UPDATE", [location[0].stage_instance_id]);
    return tx.query<CohortRow>(
      `SELECT id::text,run_id::text,stage_instance_id::text,cohort_key,state,status,round,depends_on,
              durable_version::text,stage_data FROM oakridge.cohort
       WHERE stage_instance_id=$1 ORDER BY cohort_key FOR UPDATE`, [location[0].stage_instance_id]);
  }

  start_effects(transition_ids: readonly RunTransitionId[]): Promise<void> {
    return this.dependencies.start_effects(transition_ids);
  }

  async apply(cohort_id: CohortId, event: StageEvent): Promise<Result<ApplyOutcome, ApplyStageEventError>> {
    const transition_ids: RunTransitionId[] = [];
    try {
      const outcome = await this.dependencies.sql.transaction(async (tx) => {
        const applied = await this.apply_in(tx, cohort_id, event, transition_ids, new Set<CohortId>());
        if (!applied.ok) throw new ApplyAbort(applied.error);
        return applied;
      });
      if (outcome.value.kind === "applied") await this.dependencies.start_effects(transition_ids);
      return outcome;
    } catch (error) {
      if (error instanceof ApplyAbort) return err(error.failure);
      throw error;
    }
  }

  async apply_in(tx: SqlExecutor, cohort_id: CohortId, event: StageEvent,
    transition_ids: RunTransitionId[] = [], visited: Set<CohortId> = new Set<CohortId>(),
  ): Promise<Result<ApplyOutcome, ApplyStageEventError>> {
    if (visited.has(cohort_id)) return ok({ kind: "ignored", reason: "cohort_terminal" });
    visited.add(cohort_id);
    const cohorts = await this.lock_stage_cohorts_in(tx, cohort_id);
    const cohort = cohorts.find((candidate) => candidate.id === cohort_id);
    if (!cohort) return err({ operation: "apply_stage_event", cohort_id, kind: "cohort_not_found", detail: "cohort not found" });
    const stages = await tx.query<OwnerRow>(
      "SELECT status,stage_contract FROM oakridge.stage_instance WHERE id=$1 FOR SHARE", [cohort.stage_instance_id]);
    const runs = await tx.query<OwnerRow>(
      "SELECT status FROM oakridge.workflow_run WHERE id=$1 FOR SHARE", [cohort.run_id]);
    const from = cohort.state;
    if (event.kind !== "cancel" && (isTerminal(stages[0]?.status ?? "failed") || isTerminal(runs[0]?.status ?? "failed"))) {
      return ok({ kind: "refused", code: "owner_terminal", from, detail: "run or stage is terminal" });
    }
    if (isTerminal(cohort.status)) return ok({ kind: "ignored", reason: "cohort_terminal" });
    const attempt_id = attemptedId(event);
    if (attempt_id !== null) {
      const owner = await tx.query<{ readonly worker: string }>(
        "SELECT worker FROM oakridge.attempt WHERE id=$1 AND cohort_id=$2", [attempt_id, cohort_id]);
      const latest = await tx.query<LatestAttemptRow>(
        "SELECT id::text FROM oakridge.attempt WHERE cohort_id=$1 AND worker=$2 ORDER BY attempt_number DESC LIMIT 1",
        [cohort_id, owner[0]?.worker ?? ""]);
      if (latest[0]?.id !== attempt_id) return event.kind === "session_ended"
        ? ok({ kind: "ignored", reason: "stale_attempt" })
        : ok({ kind: "refused", code: "stale_attempt", from, detail: "attempt was replaced" });
    }
    const stage_contract = stages[0]?.stage_contract as CompiledStageContract | undefined;
    const machine = stage_contract?.machine as CompiledMachine | undefined;
    if (!stage_contract || !machine) return err({ operation: "apply_stage_event", cohort_id, kind: "effect_failed", detail: "stage has no pinned machine" });
    const outputs = await tx.query<{ readonly output_name: string; readonly collection_key: string | null;
      readonly artifact_id: string; readonly body: JsonValue }>(
      `SELECT output.output_name,output.collection_key,output.artifact_id::text,artifact.body
       FROM oakridge.cohort_output output JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id
       WHERE output.cohort_id=$1 AND output.round=$2`, [cohort_id, cohort.round]);
    const round_outputs: RoundOutput[] = outputs.map((output) => ({
      output: output.output_name, collection_key: output.collection_key, artifact_id: output.artifact_id as ArtifactId,
      body: output.body,
    }));
    if (event.kind === "artifact_published") {
      const published = await tx.query<{ readonly body: JsonValue }>(
        "SELECT body FROM oakridge.artifact WHERE id=$1", [event.artifact_id]);
      if (published[0]) {
        const position = round_outputs.findIndex((output) => output.output === event.output
          && output.collection_key === event.collection_key);
        const candidate = { output: event.output, collection_key: event.collection_key,
          artifact_id: event.artifact_id, body: published[0].body };
        if (position >= 0) round_outputs[position] = candidate;
        else round_outputs.push(candidate);
      }
    }
    const stage_inputs = await this.dependencies.load_stage_inputs(tx, cohort.stage_instance_id as StageInstanceId, cohort.cohort_key);
    const selected = transition(machine, from, event,
      { event, stage_data: cohort.stage_data, round_outputs, stage_inputs, registry: this.dependencies.registry });
    if (selected.kind === "refused") return ok({ kind: "refused", code: selected.code, from,
      detail: selected.detail ?? `machine row ${selected.row_index ?? "none"} refused ${event.kind}` });
    const target = readOwn(machine.states, selected.to);
    if (!target) return err({ operation: "apply_stage_event", cohort_id, kind: "effect_failed",
      detail: `target state '${selected.to}' is undeclared` });
    const at = this.dependencies.now();
    const descriptor = effectDescriptor(selected.effects);
    const committed = await this.dependencies.writer.commit_in(tx, {
      run_id: cohort.run_id as WorkflowRunId, owner: { kind: "cohort", id: cohort_id },
      expected_version: Number(cohort.durable_version), launch_reason: launchReason(event, cohort.depends_on),
      change: { status: target.status, blocked_reason: target.blocked_reason, next_actor: target.next_actor,
        outcome: isTerminal(target.status) ? { kind: target.status } : null },
      effect: descriptor, cohort_state: selected.to, event: event as unknown as JsonValue,
      from_state: from, to_state: selected.to, actor: eventActor(event), changed_at: at,
    });
    if (!committed.ok) return err({ operation: "apply_stage_event", cohort_id, kind: "effect_failed",
      detail: `owner update failed: ${committed.error.kind}` });
    const effect_cohort: CohortEffectRow = {
      id: cohort_id, run_id: cohort.run_id as WorkflowRunId,
      stage_instance_id: cohort.stage_instance_id as StageInstanceId, round: cohort.round,
      stage_data: cohort.stage_data, stage_contract,
    };
    const effects = await runStageEffectsIn(tx, { cohort: effect_cohort, event,
      transition_id: committed.value.transition_id, at }, selected.effects, this.dependencies.registered_effects);
    if (!effects.ok) return err({ operation: "apply_stage_event", cohort_id, kind: "effect_failed", detail: effects.error.detail });
    if (effects.value.stage_data !== null) await tx.query(
      "UPDATE oakridge.cohort SET stage_data=$2::jsonb WHERE id=$1", [cohort_id, JSON.stringify(effects.value.stage_data)]);
    if (effects.value.has_external_effects) transition_ids.push(committed.value.transition_id);
    if (isTerminal(target.status)) await tx.query(
      `UPDATE oakridge.wait_gate SET status='closed',closed_at=$2::timestamptz,
         outcome=$3::jsonb WHERE cohort_id=$1 AND status='open'`,
      [cohort_id, at, JSON.stringify({ kind: "cancelled", reason: event.kind })]);
    if (target.status === "complete") {
      const siblings = await tx.query<CohortRow>(
        `SELECT id::text,run_id::text,stage_instance_id::text,cohort_key,state,status,round,depends_on,
                durable_version::text,stage_data
         FROM oakridge.cohort WHERE stage_instance_id=$1 ORDER BY cohort_key`, [cohort.stage_instance_id]);
      const max_parallel = stage_contract.max_active_cohorts;
      const startable = new Set(selectStartableCohorts(siblings.map((sibling) => ({
        cohort_key: sibling.cohort_key, state_status: sibling.status, depends_on: sibling.depends_on,
      })), max_parallel));
      for (const sibling of siblings) {
        if (!startable.has(sibling.cohort_key) || visited.has(sibling.id as CohortId)) continue;
        const started = await this.apply_in(tx, sibling.id as CohortId, { kind: "started" }, transition_ids, visited);
        if (!started.ok) return started;
      }
    }
    return ok({ kind: "applied", transition_id: committed.value.transition_id, from, to: selected.to });
  }
}
