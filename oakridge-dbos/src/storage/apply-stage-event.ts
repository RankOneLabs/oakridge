/** Cohort ingress: snapshots -> pure decisions -> atomic commits -> durable IO. */
import { type CohortEvaluationInput } from "../decision/stage-machine";
import { advanceCohortUntilWait, type CohortProgressionError } from "../runtime/run-launch-dispatch";
import type { AgentSettings, ImplementationCohortDefinition, OperatorRequestEnvelope, VerifiedPrObservation, V15RunInputs } from "../domain/dev-flow-v15";
import { artifactRefFromRevision } from "../domain/dev-flow-v15";
import { err, ok, type ArtifactId, type CohortId, type ExecutionId, type Result, type RunTransitionId, type StageInstanceId, type WorkflowRunId } from "../domain/primitives";
import type { StageEvent, StateName } from "../domain/stage-machine";
import { commitSelectedCohort, type PostgresRunRecordWriter } from "./postgres-run-record";
import { loadImplementationCohortSnapshot } from "./load-run-snapshot";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";

export type ApplyOutcome =
  | { readonly kind: "applied"; readonly transition_id: RunTransitionId; readonly from: StateName; readonly to: StateName }
  | { readonly kind: "ignored"; readonly reason: "cohort_terminal" | "stale_attempt" }
  | { readonly kind: "refused"; readonly code: string; readonly from: StateName; readonly detail: string };
export interface ApplyStageEventError {
  readonly operation: "apply_stage_event";
  readonly cohort_id: CohortId;
  readonly kind: "cohort_not_found" | "effect_failed" | "event_model_retired";
  readonly detail: string;
}
interface CohortLocation {
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly state: StateName;
  readonly stage_contract: { readonly cohort?: ImplementationCohortDefinition };
  readonly context: V15RunInputs;
}
export interface ApplyStageEventDependencies {
  readonly sql: TransactionalSqlExecutor;
  readonly writer: PostgresRunRecordWriter;
  readonly now: () => string;
  readonly dispatch_executions?: (ids: readonly ExecutionId[]) => Promise<void>;
  readonly observe_pr?: (cohort_id: CohortId) => Promise<VerifiedPrObservation | null>;
}
export type CohortIngressError = CohortProgressionError | {
  readonly kind: "cohort_not_found" | "invalid_snapshot" | "stage_not_supported";
  readonly cohort_id: CohortId;
  readonly detail: string;
};
class IngressAbort extends Error {
  constructor(readonly reason: CohortIngressError) { super("detail" in reason ? reason.detail : reason.kind); }
}

export class StageEventApplier {
  constructor(private readonly dependencies: ApplyStageEventDependencies) {}

  async lock_stage_cohorts_in(tx: SqlExecutor, cohort_id: CohortId): Promise<readonly { readonly id: string }[]> {
    const rows = await tx.query<{ readonly stage_instance_id: string }>(
      "SELECT stage_instance_id::text FROM oakridge.cohort WHERE id=$1", [cohort_id]);
    if (!rows[0]) return [];
    await tx.query("SELECT id FROM oakridge.stage_instance WHERE id=$1 FOR UPDATE", [rows[0].stage_instance_id]);
    return tx.query<{ readonly id: string }>(
      "SELECT id::text FROM oakridge.cohort WHERE stage_instance_id=$1 ORDER BY cohort_key FOR UPDATE", [rows[0].stage_instance_id]);
  }

  /** A coherent, referenced snapshot; no progression decision is made by storage. */
  private async load_in(tx: SqlExecutor, cohort_id: CohortId): Promise<{
    readonly location: CohortLocation;
    readonly evaluation: Omit<CohortEvaluationInput, "request" | "pr">;
    readonly settings: Readonly<{ build: AgentSettings; assessment: AgentSettings }>;
  }> {
    const locations = await tx.query<CohortLocation>(
      `SELECT cohort.run_id::text,cohort.stage_instance_id::text,cohort.state,stage.stage_contract,run.context
       FROM oakridge.cohort cohort JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
       JOIN oakridge.workflow_run run ON run.id=cohort.run_id WHERE cohort.id=$1`, [cohort_id]);
    const location = locations[0];
    if (!location) throw new IngressAbort({ kind: "cohort_not_found", cohort_id, detail: "cohort not found" });
    const definition = location.stage_contract.cohort;
    if (!definition || !("build" in definition.workers) || !("assessment" in definition.workers))
      throw new IngressAbort({ kind: "stage_not_supported", cohort_id,
        detail: "this stage has no pinned implementation cohort tree; stage materialization arrives in b4" });
    const snapshot = await loadImplementationCohortSnapshot(tx, cohort_id);
    if (!snapshot.ok) throw new IngressAbort(snapshot.error);
    const artifacts = await tx.query<{ readonly chain_id: ArtifactId; readonly revision: number }>(
      `SELECT artifact.chain_id::text,artifact.revision FROM oakridge.artifact artifact
       JOIN oakridge.artifact_owner owner ON owner.artifact_id=artifact.id WHERE owner.run_id=$1`, [location.run_id]);
    const settingsFor = (source: "run.builder" | "run.planner") => source === "run.builder"
      ? location.context.builder : location.context.planner;
    const settings = { build: settingsFor(definition.workers.build.execution.settings.from),
      assessment: settingsFor(definition.workers.assessment.execution.settings.from) };
    if (!settings.build || !settings.assessment) throw new IngressAbort({ kind: "invalid_snapshot", cohort_id,
      detail: "run is missing pinned builder/planner settings" });
    return { location, evaluation: { definition, snapshot: snapshot.value,
      available_artifacts: artifacts.map(artifactRefFromRevision) }, settings };
  }

  private async request_replay(cohort_id: CohortId, request: OperatorRequestEnvelope):
    Promise<Result<{ readonly commits: number; readonly reason: string }, CohortIngressError> | null> {
    const rows = await this.dependencies.sql.query<{ readonly cohort_id: CohortId; readonly same_request: boolean }>(
      `SELECT cohort_id::text,request=$2::jsonb AS same_request FROM oakridge.cohort_request_receipt WHERE request_id=$1`,
      [request.id, JSON.stringify(request.request)]);
    if (!rows[0]) return null;
    return rows[0].cohort_id === cohort_id && rows[0].same_request
      ? ok({ commits: 0, reason: "request already consumed" })
      : err({ kind: "invalid_decision", detail: "request identity was reused for different work" });
  }

  async advance(cohort_id: CohortId, request: OperatorRequestEnvelope | null):
    Promise<Result<{ readonly commits: number; readonly reason: string }, CohortIngressError>> {
    try {
      const replay = request ? await this.request_replay(cohort_id, request) : null;
      if (replay) return replay;
      // Verified IO observations are supplied as facts, never as decisions.
      const pr = await this.dependencies.observe_pr?.(cohort_id) ?? null;
      let loaded: Awaited<ReturnType<StageEventApplier["load_in"]>>;
      const result = await advanceCohortUntilWait({
        load: async () => {
          loaded = await this.dependencies.sql.transaction(async (tx) => {
            await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", []);
            return this.load_in(tx, cohort_id);
          });
          return { ...loaded.evaluation, pr };
        },
        commit: (selected, envelope) => commitSelectedCohort(this.dependencies.sql, {
          run_id: loaded.location.run_id, stage_instance_id: loaded.location.stage_instance_id,
          cohort_id, selected, request: envelope, definition: loaded.evaluation.definition,
          settings: loaded.settings, actor: envelope ? "operator" : "core", at: this.dependencies.now(),
        }),
        dispatch: (ids) => this.dependencies.dispatch_executions?.(ids) ?? Promise.resolve(),
      }, request);
      // A concurrent delivery can consume the same identity while this delivery
      // reloads after a version conflict. Its receipt is the authoritative answer.
      if (!result.ok && request) {
        const replay = await this.request_replay(cohort_id, request);
        if (replay) return replay;
      }
      return result;
    } catch (cause) {
      if (cause instanceof IngressAbort) return err(cause.reason);
      throw cause;
    }
  }

  /** Old event lists cannot author decisions. Later cohorts replace these graph callers. */
  async apply(cohort_id: CohortId, event: StageEvent): Promise<Result<ApplyOutcome, ApplyStageEventError>> {
    return this.dependencies.sql.transaction((tx) => this.apply_in(tx, cohort_id, event));
  }
  async apply_in(tx: SqlExecutor, cohort_id: CohortId, event: StageEvent,
    _transitions: RunTransitionId[] = [], _visited: Set<CohortId> = new Set()): Promise<Result<ApplyOutcome, ApplyStageEventError>> {
    const rows = await tx.query<{ readonly state: StateName; readonly durable_version: string; readonly run_id: WorkflowRunId }>(
      "SELECT state,durable_version::text,run_id::text FROM oakridge.cohort WHERE id=$1 FOR UPDATE", [cohort_id]);
    const row = rows[0];
    if (!row) return err({ operation: "apply_stage_event", cohort_id, kind: "cohort_not_found", detail: "cohort not found" });
    if (event.kind !== "cancel") return err({ operation: "apply_stage_event", cohort_id, kind: "event_model_retired",
      detail: "event-list progression is retired; submit a typed cohort request or recheck the cohort snapshot" });
    // Run cancellation is an owner operation, independent of stage materialization.
    if (["complete", "failed", "cancelled"].includes(row.state)) return ok({ kind: "ignored", reason: "cohort_terminal" });
    const committed = await this.dependencies.writer.commit_in(tx, {
      run_id: row.run_id, owner: { kind: "cohort", id: cohort_id }, expected_version: Number(row.durable_version),
      launch_reason: "operator", change: { status: "cancelled", blocked_reason: null, next_actor: null,
        outcome: { kind: "cancelled" } }, effect: { kind: "none" }, cohort_state: "cancelled" as StateName,
      actor: event.actor, changed_at: this.dependencies.now(),
    });
    if (!committed.ok) return err({ operation: "apply_stage_event", cohort_id, kind: "effect_failed", detail: committed.error.kind });
    await tx.query("UPDATE oakridge.cohort_worker SET state='cancelled' WHERE cohort_id=$1", [cohort_id]);
    await tx.query("UPDATE oakridge.cohort SET activation_slot=NULL WHERE id=$1", [cohort_id]);
    await tx.query(`UPDATE oakridge.execution_intent SET stop_requested_at=COALESCE(stop_requested_at,$2::timestamptz),
      status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END WHERE cohort_id=$1`, [cohort_id, this.dependencies.now()]);
    await tx.query(`UPDATE oakridge.session SET fenced_at=COALESCE(fenced_at,$2::timestamptz)
      WHERE attempt_id IN (SELECT id FROM oakridge.attempt WHERE cohort_id=$1)`, [cohort_id, this.dependencies.now()]);
    return ok({ kind: "applied", transition_id: committed.value.transition_id, from: row.state, to: "cancelled" as StateName });
  }
  async start_effects(ids: readonly RunTransitionId[]): Promise<void> {
    if (ids.length > 0) throw new Error("legacy effect dispatch is retired; dispatch selected execution identities");
  }
}
