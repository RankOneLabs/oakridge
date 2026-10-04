import { parseReviewArtifact } from "../validation/review-artifacts";
import type { PlanningInputs } from "../domain/dev-flow-v15";
import { validatePlanCohorts, validateBriefCollection } from "../decision/schedule-cohorts";
import type { PlanBody } from "../domain/dev-flow-artifacts";
import { isDeepStrictEqual } from "node:util";
import { artifactRefFromRevision } from "../domain/dev-flow-v15";
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
import type { ExternalExecutionReference } from "../domain/execution";
import { err, ok, type ArtifactId, type AttemptId, type CohortId, type JsonValue, type Result, type RunRecordVersion, type SessionId, type StageInstanceId, type UnitId, type WorkflowRunId } from "../domain/primitives";
import type { CoreStatus } from "../domain/records";
import type { DeleteRunResult } from "../domain/runs";
import type {
  CancelRunRecord,
  CancelRunRecordResult,
  CancelledRunSession,
  CommittedRunTransition,
  InitializeRun,
  InitializeRunResult,
  ObserveSession,
  PublishWorkOrderArtifact,
  PublishWorkOrderArtifactResult,
  SessionStatusWrite,
  RunDecision,
  RunRecordRepositoryError,
  StageRosterError,
} from "../domain/run-record";
import { capabilityFor, capabilityHash } from "../runtime/publication-capability";
import { recordImplementationPublicationIn } from "./postgres-dev-flow";
import { loadRunSnapshot } from "./load-run-snapshot";
import { writeSessionStatus, publishWorkerOutputIn, type PostgresRunRecordWriter } from "./postgres-run-record";
import type { StageEventApplier } from "./apply-stage-event";
import type { RunRecordRepository } from "./repositories";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";

const CAPABILITY_SECRET = "work_order_capability";
const isTerminalStatus = (status: CoreStatus): boolean => status === "complete" || status === "failed" || status === "cancelled";

class PublishAbort extends Error {
  constructor(readonly code: string, readonly detail: string) { super(detail); }
}


/** How many version races one owner's cancellation will lose before giving up. */

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
    private readonly stage_event_applier: StageEventApplier,
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
      const runs = await tx.query<{ readonly record_version: string; readonly status: CoreStatus }>(
        "SELECT status,record_version::text FROM oakridge.workflow_run WHERE id=$1 FOR UPDATE", [input.run_id]);
      if (!runs[0]) return null;
      if (isTerminalStatus(runs[0].status)) return Math.max(1, Number(runs[0].record_version));
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

  async fail_stage_roster(stage_instance_id: StageInstanceId, detail: string, failed_at: string): Promise<Result<void, StageRosterError>> {
    return this.sql.transaction(async (tx) => {
      const rows = await tx.query<{ readonly run_id: string; readonly durable_version: string; readonly status: CoreStatus }>(
        "SELECT run_id::text,durable_version::text,status FROM oakridge.stage_instance WHERE id=$1 FOR UPDATE", [stage_instance_id]);
      const stage = rows[0];
      if (!stage) return err({ operation: "fail_stage_roster", stage_instance_id,
        kind: "stage_not_found", detail: `stage instance '${stage_instance_id}' was not found` });
      if (isTerminalStatus(stage.status)) return ok(undefined);
      const committed = await this.writer.commit_in(tx, {
        run_id: stage.run_id as WorkflowRunId, owner: { kind: "stage_instance", id: stage_instance_id },
        expected_version: Number(stage.durable_version), launch_reason: "recovery",
        change: { status: "failed", blocked_reason: null, next_actor: null,
          outcome: { kind: "failed", code: "roster_failed", detail } },
        effect: { kind: "none" }, actor: "core", changed_at: failed_at,
      });
      if (committed.ok || committed.error.kind === "owner_terminal") return ok(undefined);
      return err({ operation: "fail_stage_roster", stage_instance_id,
        kind: committed.error.kind === "owner_not_found" ? "stage_not_found" : committed.error.kind,
        detail: `stage roster failure commit: ${committed.error.kind}` });
    });
  }

  async list_stage_cohort_ids(stage_instance_id: StageInstanceId): Promise<readonly CohortId[]> {
    const rows = await this.sql.query<{ readonly id: string }>(
      "SELECT id::text FROM oakridge.cohort WHERE stage_instance_id=$1 ORDER BY cohort_key", [stage_instance_id]);
    return rows.map((row) => row.id as CohortId);
  }

  /* ----------------------- attempts and sessions ----------------------- */

  async observe_session(input: ObserveSession): Promise<SessionStatusWrite> {
    const written = await this.sql.transaction(async (tx) => {
      const written = await writeSessionStatus(tx,
        { session_id: input.session_id, status: statusFromHealth(input.health), at: input.observed_at });
      if (!written.ok) throw new Error(`${written.error.operation}:${written.error.kind}:${written.error.detail}`);
      return written.value;
    });
    if (input.health.kind !== "running") {
      const rows = await this.sql.query<{ readonly cohort_id: CohortId }>(
        `SELECT intent.cohort_id::text FROM oakridge.session session
         JOIN oakridge.execution_intent intent ON intent.attempt_id=session.attempt_id
         WHERE session.id=$1`, [input.session_id]);
      if (rows[0]) await this.stage_event_applier.advance_local(rows[0].cohort_id);
    }
    return written;
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
       WHERE attempt.cohort_id=$1 AND attempt.worker =
         (SELECT worker FROM oakridge.attempt WHERE id=$2 AND cohort_id=$1)
         AND attempt.attempt_number <
         (SELECT attempt_number FROM oakridge.attempt WHERE id=$2 AND cohort_id=$1)
         AND session.kbbl_session_id IS NOT NULL AND session.fenced_at IS NULL
       ORDER BY attempt.attempt_number`, [cohort_id, attempt_id]);
    return rows.map((row) => ({ session_id: row.session_id as SessionId,
      attempt_id: row.attempt_id as AttemptId, adapter_reference: row.adapter_reference }));
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
    return this.publishStageArtifact(request, false);
  }

  check_artifact_publication(request: PublishWorkOrderArtifact): Promise<PublishWorkOrderArtifactResult | null> {
    return this.publishStageArtifact(request, true);
  }

  private publishStageArtifact(request: PublishWorkOrderArtifact, check_only: false): Promise<PublishWorkOrderArtifactResult>;
  private publishStageArtifact(request: PublishWorkOrderArtifact, check_only: true): Promise<PublishWorkOrderArtifactResult | null>;
  private async publishStageArtifact(request: PublishWorkOrderArtifact, check_only: boolean): Promise<PublishWorkOrderArtifactResult | null> {
    const seed = await this.load_work_order_capability_seed();
    const expected = capabilityHash(capabilityFor(seed, request.attempt_id as unknown as import("../domain/primitives").WorkOrderId));
    let result: PublishWorkOrderArtifactResult | null;
    try {
      result = await this.sql.transaction(async (tx): Promise<PublishWorkOrderArtifactResult | null> => {
        const locations = await tx.query<{ readonly stage_instance_id: StageInstanceId; readonly run_id: WorkflowRunId; readonly cohort_id: CohortId }>(
          "SELECT stage_instance_id::text,run_id::text,cohort_id::text FROM oakridge.attempt WHERE id=$1", [request.attempt_id]);
        if (!locations[0]) return { kind: "work_not_found", detail: "attempt has no selected worker execution" };
        await tx.query("SELECT id FROM oakridge.stage_instance WHERE id=$1 FOR SHARE", [locations[0].stage_instance_id]);
        await tx.query("SELECT id FROM oakridge.workflow_run WHERE id=$1 FOR SHARE", [locations[0].run_id]);
        await tx.query("SELECT id FROM oakridge.cohort WHERE id=$1 FOR UPDATE", [locations[0].cohort_id]);
        const rows = await tx.query<{ readonly execution_id: import("../domain/primitives").ExecutionId;
          readonly run_id: WorkflowRunId; readonly cohort_id: CohortId; readonly worker: import("../domain/dev-flow-v15").V15WorkerKey;
          readonly record_version: string; readonly stage_contract: { readonly cohort?: {
            readonly workers: Partial<Record<import("../domain/dev-flow-v15").V15WorkerKey, {
              readonly outputs: Readonly<Record<string, { readonly type: string; readonly collection_key?: string }>> }>> } };
          readonly resolved_input: JsonValue; readonly action_point: string;
          readonly accepted_build: import("../domain/dev-flow-v15").AcceptedBuild | null }>(
          `SELECT intent.id AS execution_id,attempt.run_id::text,intent.cohort_id::text,intent.worker,
            run.record_version::text,stage.stage_contract,intent.resolved_input,intent.action_point,cohort.accepted_build
           FROM oakridge.execution_intent intent
           JOIN oakridge.attempt attempt ON attempt.id=intent.attempt_id
           JOIN oakridge.cohort cohort ON cohort.id=intent.cohort_id
           JOIN oakridge.stage_instance stage ON stage.id=attempt.stage_instance_id
           JOIN oakridge.workflow_run run ON run.id=attempt.run_id
           WHERE intent.attempt_id=$1`, [request.attempt_id]);
        const owner = rows[0];
        if (!owner) return { kind: "work_not_found", detail: "attempt has no selected worker execution" };
        if (request.capability_hash !== expected) return { kind: "invalid_capability", detail: "work-order capability is invalid" };
        const identity = { run_id: owner.run_id, cohort_id: owner.cohort_id,
          record_version: Number(owner.record_version) as RunRecordVersion };
        if (request.output_name === "assessment_unchanged") {
          if (owner.worker !== "assessment" || request.collection_key)
            return { kind: "slot_not_found", detail: "unchanged assessment is available only to the assessor" };
          const body = isObject(request.body) ? request.body : null;
          const supplied_ref = body && isObject(body.assessment) ? body.assessment : null;
          const supplied_build = body && isObject(body.build) ? body.build : null;
          const explanation = body?.explanation;
          const action_input = isObject(owner.resolved_input) ? owner.resolved_input : null;
          const discussion = owner.action_point === "discuss" ? action_input
            : owner.action_point === "retry" && action_input && isObject(action_input.work)
              && action_input.work.action_point === "discuss" && isObject(action_input.work.input)
                ? action_input.work.input : null;
          const pinned_ref = discussion && isObject(discussion.current_assessment) ? discussion.current_assessment : null;
          const pinned_build = discussion && isObject(discussion.accepted_build) ? discussion.accepted_build : null;
          if (!discussion || !supplied_ref || !supplied_build || typeof explanation !== "string" || !explanation.trim()
            || !isDeepStrictEqual(supplied_ref, pinned_ref)
            || !isDeepStrictEqual(supplied_build, pinned_build)
            || !isDeepStrictEqual(supplied_build, owner.accepted_build))
            return { kind: "refused", code: "assessment_response_mismatch", detail: "unchanged response must identify the discussion's assessment and accepted build" };
          const current = await tx.query<{ readonly artifact_id: ArtifactId; readonly chain_id: string; readonly revision: number;
            readonly active_execution_id: string | null; readonly response: JsonValue | null;
            readonly intent_status: string; readonly stop_requested_at: string | null }>(
            `SELECT artifact.id::text AS artifact_id,artifact.chain_id::text,artifact.revision,
               worker.active_execution_id,worker.response,intent.status AS intent_status,intent.stop_requested_at::text
             FROM oakridge.execution_intent intent
             JOIN oakridge.cohort_worker worker ON worker.cohort_id=intent.cohort_id AND worker.worker='assessment'
             JOIN oakridge.worker_output output ON output.cohort_id=intent.cohort_id AND output.worker='assessment' AND output.output_name='assessment'
             JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id
             WHERE intent.id=$1 FOR UPDATE OF intent,worker`, [owner.execution_id]);
          const row = current[0];
          if (!row || row.chain_id !== supplied_ref.id || row.revision !== supplied_ref.version)
            return { kind: "refused", code: "stale_assessment", detail: "assessment content version is no longer current" };
          const prior = isObject(row.response ?? undefined) ? row.response as Readonly<Record<string, JsonValue>> : null;
          if (prior?.execution_id === owner.execution_id) return prior.explanation === explanation
            ? { kind: "already_applied", artifact_id: row.artifact_id, ...identity }
            : { kind: "idempotency_conflict", artifact_id: row.artifact_id, detail: "execution already recorded a different response" };
          if (check_only) return null;
          if (row.active_execution_id !== owner.execution_id || row.stop_requested_at !== null || row.intent_status !== "dispatched")
            return { kind: "refused", code: "publication_fenced", detail: "assessment execution has no publication authority" };
          await tx.query(`UPDATE oakridge.cohort_worker SET response=$3::jsonb WHERE cohort_id=$1 AND worker=$2`,
            [owner.cohort_id, "assessment", JSON.stringify({ kind: "unchanged", execution_id: owner.execution_id,
              assessment: supplied_ref, build: supplied_build, explanation: explanation.trim() })]);
          await tx.query(`UPDATE oakridge.worker_output SET acceptance_state='unreviewed',reviewed_target=NULL
            WHERE cohort_id=$1 AND worker='assessment' AND output_name='assessment'`, [owner.cohort_id]);
          await tx.query("UPDATE oakridge.artifact SET acceptance_state='unreviewed' WHERE id=$1", [row.artifact_id]);
          return { kind: "published", artifact_id: row.artifact_id, ...identity };
        }
        const outputs = owner.stage_contract.cohort?.workers[owner.worker]?.outputs;
        const declared = outputs && Object.entries(outputs).find(([name]) => name === request.output_name)?.[1];
        if (!declared) return { kind: "slot_not_found", detail: `worker ${owner.worker} does not declare ${request.output_name}` };
        const validated = parseReviewArtifact(declared.type, request.body);
        if (!validated.ok) return { kind: "refused", code: "invalid_artifact_body", detail: validated.error.detail };
        if (validated.value?.type === "dev.plan") {
          const rows = await tx.query<{ readonly frozen_inputs: PlanningInputs }>(
            "SELECT frozen_inputs FROM oakridge.cohort WHERE id=$1", [owner.cohort_id]);
          const inputs = rows[0]?.frozen_inputs;
          if (!inputs) return { kind: "refused", code: "missing_plan_inputs", detail: "planning cohort has no frozen inputs" };
          const graph = validatePlanCohorts(validated.value.body, new Set(inputs.repositories.map((repository) => repository.repository_key)));
          if (!graph.ok) return { kind: "refused", code: "invalid_plan_graph", detail: graph.error.detail };
        }
        if (validated.value?.type === "dev.build_brief") {
          const plans = await tx.query<{ readonly body: PlanBody }>(`SELECT artifact.body FROM oakridge.cohort cohort
            JOIN oakridge.artifact artifact ON artifact.chain_id=(cohort.frozen_inputs #>> '{plan,id}')::uuid
              AND artifact.revision=(cohort.frozen_inputs #>> '{plan,version}')::int
            JOIN oakridge.artifact_owner artifact_owner ON artifact_owner.artifact_id=artifact.id AND artifact_owner.run_id=cohort.run_id
            WHERE cohort.id=$1`, [owner.cohort_id]);
          const member = plans[0]?.body.cohorts.find((cohort) => cohort.id === request.collection_key);
          if (!member) return { kind: "refused", code: "collection_identity_mismatch", detail: "brief collection member is absent from the accepted plan" };
          const matched = validateBriefCollection([member], [validated.value.body]);
          if (!matched.ok) return { kind: "refused", code: "collection_contract_mismatch", detail: matched.error.detail };
        }
        if (Boolean(declared.collection_key) !== Boolean(request.collection_key))
          return { kind: "slot_not_found", detail: "publication collection key does not match the declared output" };
        if (owner.worker === "brief" && isObject(request.body) && request.body.cohort_id !== request.collection_key)
          return { kind: "refused", code: "collection_identity_mismatch", detail: "brief body and collection key disagree" };
        const input = isObject(owner.resolved_input) ? owner.resolved_input : null;
        const pinned_build = input && isObject(input.accepted_build) ? input.accepted_build
          : input && isObject(input.work) && isObject(input.work.input) && isObject(input.work.input.accepted_build)
            ? input.work.input.accepted_build : null;
        if (owner.worker === "assessment" && (!owner.accepted_build || !pinned_build
          || !isDeepStrictEqual(owner.accepted_build, pinned_build)))
          return { kind: "refused", code: "accepted_build_mismatch", detail: "assessment is not pinned to the current accepted build" };
        const current = await tx.query<{ readonly id: ArtifactId; readonly chain_id: ArtifactId; readonly revision: number;
          readonly attempt_id: AttemptId; readonly same_body: boolean }>(
          `SELECT artifact.id::text,artifact.chain_id::text,artifact.revision,provenance.attempt_id::text,
            artifact.body=$4::jsonb AS same_body FROM oakridge.worker_output output
           JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id
           JOIN oakridge.artifact_provenance provenance ON provenance.artifact_id=artifact.id
           WHERE output.cohort_id=$1 AND output.worker=$2 AND output.output_name=$3 AND output.collection_key IS NOT DISTINCT FROM $5`,
          [owner.cohort_id, owner.worker, request.output_name, JSON.stringify(request.body), request.collection_key]);
        const tip = current[0];
        if (tip?.attempt_id === request.attempt_id) return tip.same_body
          ? { kind: "already_applied", artifact_id: tip.id, ...identity }
          : { kind: "idempotency_conflict", artifact_id: tip.id, detail: "this execution already published a different body" };
        if (check_only) {
          const authority = await tx.query<{ readonly has_authority: boolean }>(
            `SELECT worker.active_execution_id=intent.id AND intent.stop_requested_at IS NULL
              AND intent.status='dispatched' AND stage.status='active' AND run.status='active' AS has_authority
             FROM oakridge.execution_intent intent
             JOIN oakridge.cohort_worker worker ON worker.cohort_id=intent.cohort_id AND worker.worker=intent.worker
             JOIN oakridge.attempt attempt ON attempt.id=intent.attempt_id
             JOIN oakridge.stage_instance stage ON stage.id=attempt.stage_instance_id
             JOIN oakridge.workflow_run run ON run.id=attempt.run_id
             WHERE intent.id=$1`, [owner.execution_id]);
          return authority[0]?.has_authority === true ? null
            : { kind: "refused", code: "publication_fenced", detail: "execution has no publication authority" };
        }
        const evidence = isObject(request.enrichment ?? undefined) ? request.enrichment as Readonly<Record<string, JsonValue>> : null;
        const verified_head = typeof evidence?.origin_head_sha === "string" ? evidence.origin_head_sha : null;
        if (request.output_name === "pr_summary" && !verified_head)
          return { kind: "refused", code: "pr_verification_failed", detail: "PR summary has no verified pushed head" };
        const published = await publishWorkerOutputIn(tx, { execution_id: owner.execution_id, artifact_id: request.artifact_id,
          output_name: request.output_name, collection_key: request.collection_key ?? null, artifact_type: declared.type, body: request.body,
          expected: tip ? artifactRefFromRevision(tip) : null, at: request.published_at });
        if (!published.ok) return { kind: "refused", code: published.error.kind, detail: published.error.detail };
        if (request.output_name === "pr_summary" && owner.worker === "build") {
          const recorded = await recordImplementationPublicationIn(tx, { cohort_id: owner.cohort_id,
            enrichment: request.enrichment ?? null, at: request.published_at });
          if (!recorded.ok) throw new PublishAbort(recorded.error.code, recorded.error.detail);
        }
        const current_outputs = await tx.query<{ readonly output_name: string; readonly collection_key: string | null; readonly chain_id: ArtifactId;
          readonly revision: number; readonly attempt_id: AttemptId }>(
          `SELECT output.output_name,output.collection_key,artifact.chain_id::text,artifact.revision,provenance.attempt_id::text
           FROM oakridge.worker_output output JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id
           JOIN oakridge.artifact_provenance provenance ON provenance.artifact_id=artifact.id
           WHERE output.cohort_id=$1 AND output.worker=$2`, [owner.cohort_id, owner.worker]);
        const current_ref = (name: string) => {
          const row = current_outputs.find((candidate) => candidate.output_name === name && candidate.attempt_id === request.attempt_id);
          return row ? artifactRefFromRevision(row) : null;
        };
        if (owner.worker === "build") {
          const prior = await tx.query<{ readonly response: import("../domain/dev-flow-v15").BuildResponse | null }>(
            "SELECT response FROM oakridge.cohort_worker WHERE cohort_id=$1 AND worker='build'", [owner.cohort_id]);
          const response = { execution_id: owner.execution_id, build_result: current_ref("build_result"),
            pr_summary: current_ref("pr_summary"), head_sha: verified_head ?? prior[0]?.response?.head_sha ?? null };
          await tx.query("UPDATE oakridge.cohort_worker SET response=$2::jsonb WHERE cohort_id=$1 AND worker='build'",
            [owner.cohort_id, JSON.stringify(response)]);
        } else if (owner.worker === "assessment") {
          await tx.query("UPDATE oakridge.cohort_worker SET response=$2::jsonb WHERE cohort_id=$1 AND worker='assessment'",
            [owner.cohort_id, JSON.stringify({ kind: "published", execution_id: owner.execution_id,
              assessment: published.value, build: owner.accepted_build })]);
        } else {
          const current = owner.worker === "brief" ? { members: current_outputs.filter((row) => row.attempt_id === request.attempt_id)
            .map((row) => ({ cohort_key: row.collection_key, ref: artifactRefFromRevision(row) })) } : published.value;
          await tx.query("UPDATE oakridge.cohort_worker SET response=$3::jsonb WHERE cohort_id=$1 AND worker=$2",
            [owner.cohort_id, owner.worker, JSON.stringify({ execution_id: owner.execution_id, current,
              ...(owner.worker === "final_integration" ? { head_sha: verified_head } : {}) })]);
        }
        return { kind: "published", artifact_id: request.artifact_id, ...identity };
      });
    } catch (cause) {
      if (cause instanceof PublishAbort) return { kind: "refused", code: cause.code, detail: cause.detail };
      throw cause;
    }
    // Publication is a fact. The tree, never the publication boundary, decides readiness.
    if (result?.kind === "published") await this.stage_event_applier.advance(result.cohort_id, null);
    return result;
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
   * Cancels cohorts, stages and the run atomically under their owner versions.
   * Stage locks exclude late roster commits before we enumerate the cohorts.
   * Re-entry also sweeps remaining owners when the run is already terminal.
   * The caller fences external sessions after the transaction commits.
   */
  async cancel_run(input: CancelRunRecord): Promise<CancelRunRecordResult> {
    return this.cancelStageRun(input);
  }

  private async cancelStageRun(input: CancelRunRecord): Promise<CancelRunRecordResult> {
    const applier = this.stage_event_applier;
    const result = await this.sql.transaction(async (tx): Promise<CancelRunRecordResult> => {
      const stages = await tx.query<{ readonly id: string; readonly durable_version: string; readonly status: CoreStatus }>(
        `SELECT id::text,durable_version::text,status FROM oakridge.stage_instance
         WHERE run_id=$1 ORDER BY stage_key FOR UPDATE`, [input.run_id]);
      const runs = await tx.query<{ readonly record_version: string; readonly status: CoreStatus }>(
        "SELECT record_version::text,status FROM oakridge.workflow_run WHERE id=$1 FOR UPDATE", [input.run_id]);
      const cohorts = await tx.query<{ readonly id: string }>(
        `SELECT cohort.id::text FROM oakridge.cohort cohort
         JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
         WHERE cohort.run_id=$1 AND cohort.status NOT IN ('complete','failed','cancelled')
         ORDER BY stage.stage_key,cohort.cohort_key`, [input.run_id]);
      for (const cohort of cohorts) {
        const applied = await applier.cancel_in(tx, cohort.id as CohortId, input.actor);
        if (!applied.ok || applied.value.kind === "refused") throw new Error(`cancel cohort ${cohort.id}: ${JSON.stringify(applied)}`);
      }
      for (const stage of stages) {
        if (isTerminalStatus(stage.status)) continue;
        const changed = await this.writer.commit_in(tx, {
          run_id: input.run_id, owner: { kind: "stage_instance", id: stage.id as StageInstanceId },
          expected_version: Number(stage.durable_version), launch_reason: "operator",
          change: { status: "cancelled", blocked_reason: null, next_actor: null,
            outcome: { kind: "cancelled", reason: input.reason } },
          effect: { kind: "none" }, actor: input.actor, changed_at: input.cancelled_at,
        });
        if (!changed.ok) throw new Error(`cancel stage ${stage.id}: ${changed.error.kind}`);
      }
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
    if (result.kind === "cancelled" || result.kind === "already_terminal") return {
      ...result, sessions_to_fence: await this.listSessionsToFence(input.run_id),
    };
    return result;
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
        "DELETE FROM oakridge.worker_output WHERE cohort_id IN (SELECT id FROM oakridge.cohort WHERE run_id=$1)",
        "UPDATE oakridge.cohort_worker SET active_execution_id=NULL WHERE cohort_id IN (SELECT id FROM oakridge.cohort WHERE run_id=$1)",
        "DELETE FROM oakridge.execution_intent WHERE cohort_id IN (SELECT id FROM oakridge.cohort WHERE run_id=$1)",
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
