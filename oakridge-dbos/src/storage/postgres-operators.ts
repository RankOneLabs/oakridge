import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId, WorkOrderId } from "../domain/primitives";
import { selectGateActionability, selectV15StageOrder, selectPullRequestMergeWaits, type OperatorApplicationVersionInventory, type OperatorCohortSummary, type CohortDetailContributor, type OperatorParkedGate, type OperatorReviewInbox, type OperatorReviewInboxItem, type OperatorRunDetail, type OperatorRunDiagnosis, type OperatorRunDiagnosisSession, type OperatorRunSummary, type OperatorSessionRunLocation, type OperatorStageArtifact, type OperatorStageDetail, type OperatorStageUnit } from "../domain/operator-projections";
import type { SqlExecutor } from "./sql-executor";
import type { BlockedReason, CoreStatus, NextActor } from "../domain/records";
import { type AdapterRoleRegistry } from "../runtime/executor-registry";
import { stageInstanceIdFor } from "../decision/ids";
import type { StageKey, V15WorkerKey } from "../domain/dev-flow-v15";
import { parseV15WorkflowDefinition } from "../validation/v15-definition";
import { loadStageCohortContext } from "./load-stage-cohort";
import { selectCohortWorkerRecords, selectCohortRepositoryView } from "../domain/cohort-operator-view";
import { selectSessionHoldClaim, type SessionHold } from "../domain/session-hold";
import type { SessionHoldRepository, SessionRunLocationRepository } from "./repositories";
import { runRecordWorkflowId } from "../domain/workflow-ids";
import { projectRunEvent, type RunEvent, type RunEventRow } from "../domain/run-event";
import type { CohortId } from "../domain/primitives";

interface WorkerReviewProjectionRow {
  readonly cohort_id: string; readonly worker: V15WorkerKey; readonly run_id: string;
  readonly stage_name: string; readonly stage_instance_id: string; readonly unit_id: string;
  readonly artifact_revision_ids: readonly string[]; readonly run_state: CoreStatus;
}

export interface OperatorProjectionRepository {
  list_pending_gates(run_id?: WorkflowRunId): Promise<readonly OperatorParkedGate[]>;
  list_runs(filter?: "active" | "archived" | "all"): Promise<readonly OperatorRunSummary[]>;
  get_run(id: WorkflowRunId): Promise<OperatorRunDetail | null>;
  get_run_diagnosis(id: WorkflowRunId): Promise<OperatorRunDiagnosis | null>;
  get_review_inbox(): Promise<OperatorReviewInbox>;
  /**
   * The raw cohort projection, without the review inbox's gate overlay. The
   * pull-request poller wants the handoff's own state, not the operator-facing
   * lifecycle the inbox blends a pending gate into.
   */
  list_cohorts(): Promise<readonly OperatorCohortSummary[]>;
  /**
   * Every attempt at every unit of the run that has an agent session, oldest
   * first — the unit's session history, not just its live attempt. No
   * state/status/cleanup predicate: a completed or abandoned attempt keeps its
   * session id (`executor_attachment.work_order_id` is a PRIMARY KEY), and
   * hiding finished attempts is exactly what would make the history useless.
   */
  set_run_archived(id: WorkflowRunId, archived: boolean): Promise<boolean>;
  get_invalidation_cursor(): Promise<string>;
  list_run_events(input: ListRunEventsInput): Promise<readonly RunEvent[]>;
  list_application_versions(): Promise<readonly OperatorApplicationVersionInventory[]>;
}

export interface ListRunEventsInput {
  readonly after_sequence: string | null;
  readonly limit: number;
  /** Null keeps the global ordering used by the SSE stream. */
  readonly run_id: WorkflowRunId | null;
}

interface V2RunProjectionRow { readonly id: string; readonly title: string | null; readonly repository_keys: readonly string[]; readonly workflow_name: string; readonly status: CoreStatus; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly current_stage: string | null; readonly stage_total: string; readonly stage_complete: string; readonly attention_count: string; readonly parked_count: string; readonly updated_at: string; readonly archived: boolean }
interface V2StageProjectionRow { readonly stage_instance_id: string; readonly name: string; readonly stage_type: string; readonly operator_role: string | null; readonly status: CoreStatus; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null }
interface V2UnitProjectionRow { readonly cohort_id: string; readonly stage_instance_id: string; readonly unit_id: string; readonly brief: OperatorStageUnit["brief"]; readonly state: string; readonly status: CoreStatus; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly session_id: string | null; readonly gate_step: string | null }
interface StageArtifactRow { readonly stage_instance_id: string; readonly id: string; readonly type_id: string; readonly version: number; readonly label: string | null; readonly created_at: string }
interface DiagnosisSessionRow { readonly session_id: string; readonly stage_key: string; readonly cohort_id: string; readonly cohort_key: string; readonly worker: V15WorkerKey; readonly execution_id: ExecutionId; readonly action_point: string; readonly is_current: boolean; readonly status: CoreStatus; readonly created_at: string }
interface V2CohortProjectionRow { readonly cohort_id: string; readonly run_id: string; readonly workflow_name: string;
  readonly stage_instance_id: string; readonly stage_name: string; readonly unit_id: string; readonly status: CoreStatus;
  readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly artifact_revision_id: string | null;
  readonly stage_type: string; readonly title: string | null; readonly updated_at: string }


interface SessionRunLocationRow {
  readonly run_id: string; readonly stage_instance_id: string; readonly stage_key: string;
  readonly unit_id: string; readonly work_order_id: string;
}

export class PostgresOperatorProjectionRepository implements OperatorProjectionRepository, SessionHoldRepository, SessionRunLocationRepository {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly executor_application_version: string,
    _adapter_roles: AdapterRoleRegistry,
  ) {}

  private readonly cohort_detail_contributors = new Map<string, CohortDetailContributor>();

  register_cohort_detail_contributor(contributor: CohortDetailContributor): void {
    this.cohort_detail_contributors.set(contributor.stage_type, contributor);
  }

  /**
   * Held while an **unfinished** session names this kbbl session and its
   * attempt's workflow is PENDING or SUCCESS. SUCCESS can mean only the initial
   * turn ended: the attempt keeps its session for review until the run record
   * releases the work, so a finished DBOS workflow is not a finished attempt.
   *
   * v14 read this off `executor_attachment` joined to a started `work_order`.
   * v15's `session` *is* the attachment — `oakridge.session UNIQUE (attempt_id)`
   * and a unique `kbbl_session_id` — so `session.ended_at IS NULL` carries
   * exactly what `work_order.state='started' AND cleanup_state <> 'complete'`
   * used to.
   *
   * The version the holder was started under is selected rather than filtered
   * on, so a workflow stranded by a version bump can be told apart from no
   * workflow at all and said out loud. Silently widening the query would leave
   * an operator with a session that became closable for no visible reason.
   */
  async find_session_hold(session_id: string): Promise<SessionHold | null> {
    const rows = await this.sql.query<{
      readonly attempt_id: string; readonly workflow_id: string; readonly run_id: string;
      readonly stage_instance_id: string; readonly stage_key: string; readonly unit_id: string;
      readonly application_version: string | null;
    }>(
      `SELECT attempt.id::text AS attempt_id,'v15-worker:' || intent.id AS workflow_id,
              session.run_id::text,session.stage_instance_id::text,stage.stage_key,cohort.cohort_key AS unit_id,
              status.application_version
       FROM oakridge.session session
       JOIN oakridge.attempt attempt ON attempt.id = session.attempt_id
       JOIN oakridge.cohort cohort ON cohort.id = attempt.cohort_id
       JOIN oakridge.stage_instance stage ON stage.id = session.stage_instance_id
       JOIN oakridge.execution_intent intent ON intent.attempt_id=attempt.id
       JOIN dbos.workflow_status status ON status.workflow_uuid = 'v15-worker:' || intent.id
       WHERE session.kbbl_session_id = $1
         AND session.ended_at IS NULL AND status.status IN ('PENDING', 'SUCCESS')
       ORDER BY session.created_at DESC LIMIT 1`,
      [session_id]);
    const row = rows[0];
    if (!row) return null;
    // The attempt id stands where v14 wrote the work order id, and v1 a legacy
    // execution id: one column, one meaning — "the execution this came from".
    const hold: SessionHold = { session_id, execution_id: row.attempt_id as ExecutionId,
      execution_workflow_id: row.workflow_id,
      run_id: row.run_id as WorkflowRunId, stage_instance_id: row.stage_instance_id as StageInstanceId,
      stage_key: row.stage_key, unit_id: row.unit_id as UnitId };
    const claim = selectSessionHoldClaim(hold, row.application_version, this.executor_application_version);
    if (claim.kind === "abandoned") {
      console.warn(`oakridge: session ${session_id} is claimed by ${claim.hold.execution_workflow_id}, ` +
        `left PENDING by application version ${claim.holder_application_version} which this executor ` +
        `(${this.executor_application_version}) cannot recover; the claim is ignored so the session can be closed`);
      return null;
    }
    return claim.hold;
  }


  /**
   * Navigation: the run a session belongs to, whatever became of the work that
   * opened it. `ORDER BY attachment.updated_at DESC` picks the most recently
   * touched attachment in the (unexpected) case that a session id was reused
   * across work orders — the session's latest home, not an arbitrary one.
   */
  async find_run_for_session(session_id: string): Promise<OperatorSessionRunLocation | null> {
    const rows = await this.sql.query<SessionRunLocationRow>(
      `SELECT session.run_id::text AS run_id,session.stage_instance_id::text AS stage_instance_id,
              stage.stage_key,cohort.cohort_key AS unit_id,attempt.id::text AS work_order_id
       FROM oakridge.session session
       JOIN oakridge.attempt attempt ON attempt.id=session.attempt_id
       JOIN oakridge.execution_intent intent ON intent.attempt_id=attempt.id
       JOIN oakridge.cohort_worker worker ON worker.cohort_id=intent.cohort_id AND worker.worker=intent.worker
       JOIN oakridge.cohort cohort ON cohort.id=attempt.cohort_id
       JOIN oakridge.stage_instance stage ON stage.id=session.stage_instance_id
       WHERE session.kbbl_session_id=$1
       ORDER BY session.created_at DESC LIMIT 1`, [session_id]);
    const row = rows[0];
    if (!row) return null;
    return { run_id: row.run_id as WorkflowRunId, stage_instance_id: row.stage_instance_id as StageInstanceId,
      stage_key: row.stage_key, unit_id: row.unit_id as UnitId, work_order_id: row.work_order_id as WorkOrderId };
  }

  async list_pending_gates(run_id?: WorkflowRunId): Promise<readonly OperatorParkedGate[]> {
    return this.listV2PendingGates(run_id);
  }

  private async listV2PendingGates(run_id?: WorkflowRunId, requiredAttentionOnly = false): Promise<readonly OperatorParkedGate[]> {
    const rows = await this.sql.query<WorkerReviewProjectionRow>(
      `SELECT cohort.id::text AS cohort_id,worker.worker,run.id::text AS run_id,
              stage.stage_key AS stage_name,stage.id::text AS stage_instance_id,cohort.cohort_key AS unit_id,
              ARRAY(SELECT output.artifact_id::text FROM oakridge.worker_output output
                    WHERE output.cohort_id=cohort.id AND output.worker=worker.worker
                      AND EXISTS (SELECT 1 FROM oakridge.artifact_provenance provenance
                        JOIN oakridge.execution_intent intent ON intent.attempt_id=provenance.attempt_id
                        WHERE provenance.artifact_id=output.artifact_id AND intent.id=worker.active_execution_id)
                    ORDER BY output.output_name,output.collection_key) AS artifact_revision_ids,
              run.status AS run_state
       FROM oakridge.cohort_worker worker
       JOIN oakridge.cohort cohort ON cohort.id=worker.cohort_id
       JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
       JOIN oakridge.workflow_run run ON run.id=cohort.run_id
       WHERE worker.state='awaiting_review' AND run.archived=false
         AND ($1::uuid IS NULL OR run.id=$1::uuid)
         AND (NOT $2::boolean OR run.status='active')
       ORDER BY stage.created_at,cohort.materialization_position,worker.worker`, [run_id ?? null, requiredAttentionOnly]);
    return Promise.all(rows.map(async (row): Promise<OperatorParkedGate> => {
      const context = await loadStageCohortContext(this.sql, row.cohort_id as CohortId, row.stage_name as StageKey);
      if (!context.ok) throw new Error(context.error.detail);
      const repository = selectCohortRepositoryView(context.value, row.stage_instance_id as StageInstanceId);
      return { id: `${row.cohort_id}:${row.worker}`, stage_instance_id: row.stage_instance_id as StageInstanceId,
        gate_type: row.worker, run_id: row.run_id as WorkflowRunId, stage_name: row.stage_name,
        unit_id: row.unit_id as UnitId, ...repository,
        artifact_revision_id: (row.artifact_revision_ids[0] ?? null) as ArtifactId | null,
        artifact_revision_ids: row.artifact_revision_ids as ArtifactId[],
        gate_step: row.worker === "final_integration" ? "merge_confirmation" : row.worker,
        resume_actions: [], pr_url: null, run_state: row.run_state,
        actionable: selectGateActionability(row.run_state) };
    }));
  }

  async list_runs(filter: "active" | "archived" | "all" = "active"): Promise<readonly OperatorRunSummary[]> {
    return this.listV2RunSummaries(filter, null);
  }

  private async listV2RunSummaries(filter: "active" | "archived" | "all", run_id: WorkflowRunId | null): Promise<readonly OperatorRunSummary[]> {
    const rows = await this.sql.query<V2RunProjectionRow>(
      `SELECT run.id::text,run.context->>'title' AS title,
              COALESCE(
                (SELECT jsonb_agg(repository.value->>'key' ORDER BY repository.ordinality)
                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(run.context->'repositories')='array' THEN run.context->'repositories' ELSE '[]'::jsonb END) WITH ORDINALITY repository(value, ordinality)),
                '[]'::jsonb
              ) AS repository_keys,
              definition.name AS workflow_name,run.status,run.blocked_reason,run.next_actor,
              current_stage.stage_key AS current_stage,
              (SELECT count(*) FROM jsonb_object_keys(definition.definition->'stages'))::text AS stage_total,
              (SELECT count(*) FROM oakridge.stage_instance stage WHERE stage.run_id=run.id AND stage.status='complete')::text AS stage_complete,
              (SELECT count(*) FROM oakridge.cohort_worker worker JOIN oakridge.cohort cohort ON cohort.id=worker.cohort_id
                WHERE cohort.run_id=run.id AND worker.state IN ('awaiting_review','interrupted')
                  AND run.status='active' AND run.archived=false)::text AS attention_count,
              (SELECT count(*) FROM oakridge.cohort_worker worker JOIN oakridge.cohort cohort ON cohort.id=worker.cohort_id
                WHERE cohort.run_id=run.id AND worker.state='awaiting_review')::text AS parked_count,
              GREATEST(run.created_at,COALESCE(run.ended_at,run.created_at),COALESCE(progress.updated_at,run.created_at))::text AS updated_at,
              run.archived
       FROM oakridge.workflow_run run
       JOIN oakridge.workflow_definition definition ON definition.id=run.workflow_definition_id
       LEFT JOIN LATERAL (SELECT stage.stage_key FROM oakridge.stage_instance stage WHERE stage.run_id=run.id AND stage.status IN ('active','blocked') ORDER BY stage.started_at DESC NULLS LAST,stage.created_at DESC LIMIT 1) current_stage ON true
       LEFT JOIN LATERAL (SELECT max(transition.created_at) AS updated_at FROM oakridge.run_transition transition WHERE transition.run_id=run.id) progress ON true
       WHERE ($1::boolean IS NULL OR run.archived=$1::boolean) AND ($2::uuid IS NULL OR run.id=$2::uuid)
       ORDER BY updated_at DESC`, [filter === "all" ? null : filter === "archived", run_id]);
    const contributedCohorts = this.cohort_detail_contributors.size > 0 ? await this.listV2Cohorts(run_id) : [];
    return rows.map((row) => {
      return { id: row.id as WorkflowRunId, title: row.title, repository_keys: row.repository_keys, workflow_name: row.workflow_name,
        current_attempt_root_workflow_id: runRecordWorkflowId(row.id as WorkflowRunId), status: row.status,
        blocked_reason: row.blocked_reason, next_actor: row.next_actor, current_stage: row.current_stage,
        stage_total: Number(row.stage_total), stage_complete: Number(row.stage_complete),
        attention_count: Number(row.attention_count) + contributedCohorts.filter((cohort) =>
          cohort.run_id === row.id && cohort.lifecycle === "blocked" && cohort.next_actor === "external"
          && cohort.links.length > 0).length, parked_count: Number(row.parked_count),
        updated_at: row.updated_at, archived: row.archived };
    });
  }

  /**
   * One summary query for both the list and the single-run detail. `get_run`
   * used to build every run's summary — stall detection, parked-gate counts and
   * all — and then discard all but one with `.find()`.
   */
  async set_run_archived(id: WorkflowRunId, archived: boolean): Promise<boolean> {
    const rows = await this.sql.query<{ readonly id: string }>(
      `UPDATE oakridge.workflow_run SET archived = $2 WHERE id = $1 RETURNING id::text`,
      [id, archived],
    );
    return rows.length === 1;
  }

  /**
   * One opaque string the SSE stream compares to decide whether any durable
   * surface has moved. Every v15 table an operator view reads from contributes
   * its own high-water mark; `run_transition.sequence` covers every core
   * status change on its own, and the rest cover the facts that change without
   * an owner transition — an artifact body, a gate closing, a message, a pull
   * request observation.
   */
  async get_invalidation_cursor(): Promise<string> {
    const rows = await this.sql.query<{ readonly cursor: string }>(
      `SELECT concat_ws(':',
         COALESCE((SELECT max(updated_at)::text FROM dbos.workflow_status), '0'),
         COALESCE((SELECT max(sequence)::text FROM oakridge.run_transition), '0'),
         COALESCE((SELECT max(created_at)::text FROM oakridge.artifact), '0'),
         COALESCE((SELECT max(recorded_at)::text FROM oakridge.worker_output), '0'),
         COALESCE((SELECT max(durable_version)::text FROM oakridge.cohort), '0'),
         COALESCE((SELECT max(created_at)::text FROM oakridge.session_message), '0'),
         COALESCE((SELECT max(updated_at)::text FROM oakridge.session), '0'),
         COALESCE((SELECT max(updated_at)::text FROM oakridge.artifact_thread), '0'),
         COALESCE((SELECT max(created_at)::text FROM oakridge.artifact_thread_message), '0'),
         '0') AS cursor`, []);
    const contributor_cursors = await Promise.all([...this.cohort_detail_contributors.values()].map((contributor) => contributor.cursor()));
    return [rows[0]?.cursor ?? "0", ...contributor_cursors].join(":");
  }

  /**
   * Best-effort notification feed over the v15 transition ledger. Durable UI
   * state is always re-read by invalidation, so an event carries the transition
   * itself — owner, launch reason, version boundary and effect — rather than a
   * projection of what the effect meant.
   */
  async list_run_events({ after_sequence, limit, run_id }: ListRunEventsInput): Promise<readonly RunEvent[]> {
    const rows = await this.sql.query<RunEventRow>(
      `SELECT transition.sequence::text,transition.id::text,transition.run_id::text,
              transition.owner_kind,transition.owner_run_id::text,transition.owner_stage_instance_id::text,
              transition.owner_cohort_id::text,transition.launch_reason,
              transition.prior_owner_version::text,transition.resulting_owner_version::text,
              transition.event,transition.from_state,transition.to_state,
              cohort.cohort_key AS unit_label,
              stage.stage_contract->'machine'->'states'->transition.to_state->>'next_actor' AS target_next_actor,
              transition.effect_descriptor,transition.effect_workflow_id,transition.actor,
              transition.created_at::text
       FROM oakridge.run_transition transition
       LEFT JOIN oakridge.cohort cohort ON cohort.id=transition.owner_cohort_id
       LEFT JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
       WHERE ($1::bigint IS NULL OR transition.sequence > $1::bigint)
         AND ($2::uuid IS NULL OR transition.run_id = $2::uuid)
       ORDER BY transition.sequence ASC LIMIT $3`, [after_sequence, run_id, limit]);
    return rows.map(projectRunEvent);
  }

  async list_application_versions(): Promise<readonly OperatorApplicationVersionInventory[]> {
    const rows = await this.sql.query<{ readonly application_version: string | null; readonly run_count: string; readonly pending_run_count: string; readonly gated_run_count: string; readonly oldest_pending_epoch_ms: string | null }>(
      // `'v15-run:'` is spelled as a SQL literal below, as in
      // `list_unstarted_runs` (`postgres-domain.ts`) — the one other place
      // outside `runMachineWorkflowId` this prefix is written.
      `SELECT status.application_version,
              count(*)::text AS run_count,
              count(*) FILTER (WHERE status.status IN ('PENDING', 'ENQUEUED', 'DELAYED'))::text AS pending_run_count,
              count(*) FILTER (WHERE gates.has_pending_gate)::text AS gated_run_count,
              min(status.created_at) FILTER (WHERE status.status IN ('PENDING', 'ENQUEUED', 'DELAYED'))::text AS oldest_pending_epoch_ms
       FROM oakridge.workflow_run run
       JOIN dbos.workflow_status status ON status.workflow_uuid = 'v15-run:' || run.id::text
       LEFT JOIN LATERAL (
         SELECT EXISTS (
           SELECT 1 FROM oakridge.cohort_worker worker JOIN oakridge.cohort cohort ON cohort.id=worker.cohort_id
           WHERE cohort.run_id=run.id AND worker.state='awaiting_review'
         ) AS has_pending_gate
       ) gates ON true
       GROUP BY status.application_version
       ORDER BY oldest_pending_epoch_ms NULLS LAST`, []);
    return rows.map((row) => ({ application_version: row.application_version, run_count: Number(row.run_count), pending_run_count: Number(row.pending_run_count), gated_run_count: Number(row.gated_run_count), oldest_pending_at: row.oldest_pending_epoch_ms === null ? null : new Date(Number(row.oldest_pending_epoch_ms)).toISOString() }));
  }

  async get_run(id: WorkflowRunId): Promise<OperatorRunDetail | null> {
    return this.getV2Run(id);
  }

  private async getV2Run(id: WorkflowRunId): Promise<OperatorRunDetail | null> {
    const summary = (await this.listV2RunSummaries("all", id))[0];
    if (!summary) return null;
    const stageRows = await this.sql.query<V2StageProjectionRow>(
      `SELECT stage.id::text AS stage_instance_id,stage.stage_key AS name,stage.stage_type,
              stage.stage_contract->>'operator_role' AS operator_role,stage.status,stage.blocked_reason,stage.next_actor
       FROM oakridge.stage_instance stage WHERE stage.run_id=$1 ORDER BY stage.created_at,stage.stage_key`, [id]);
    const unitRows = await this.sql.query<V2UnitProjectionRow>(
      `SELECT cohort.id::text AS cohort_id,cohort.stage_instance_id::text,cohort.cohort_key AS unit_id,
              brief.body AS brief,cohort.state,cohort.status,cohort.blocked_reason,cohort.next_actor,
              current_session.kbbl_session_id AS session_id,NULL::text AS gate_step
       FROM oakridge.cohort cohort
       LEFT JOIN LATERAL (
         SELECT session.kbbl_session_id FROM oakridge.cohort_worker worker
         JOIN oakridge.execution_intent intent ON intent.id=worker.active_execution_id
         JOIN oakridge.session session ON session.id=intent.session_id
         WHERE worker.cohort_id=cohort.id ORDER BY session.created_at DESC LIMIT 1
       ) current_session ON true
       LEFT JOIN oakridge.artifact brief ON brief.chain_id::text=cohort.frozen_inputs->'brief'->>'id'
         AND brief.revision=(cohort.frozen_inputs->'brief'->>'version')::integer
       WHERE cohort.run_id=$1 ORDER BY cohort.stage_instance_id,cohort.cohort_key`, [id]);
    const artifactRows = await this.sql.query<StageArtifactRow>(
      `SELECT owner.stage_instance_id::text,artifact.id::text,artifact.artifact_type AS type_id,artifact.revision AS version,artifact.label,
              artifact.created_at::text AS created_at
       FROM oakridge.artifact artifact JOIN oakridge.artifact_owner owner ON owner.artifact_id=artifact.id
       WHERE owner.run_id=$1 AND owner.stage_instance_id IS NOT NULL AND artifact.lifecycle IN ('current','released')
       ORDER BY owner.stage_instance_id,artifact.created_at,artifact.id`, [id]);
    const stages: OperatorStageDetail[] = await Promise.all(stageRows.map(async (stage) => {
      const units: OperatorStageUnit[] = await Promise.all(unitRows.filter((unit) => unit.stage_instance_id === stage.stage_instance_id).map(async (unit) => {
        const context = await loadStageCohortContext(this.sql, unit.cohort_id as CohortId, stage.name as StageKey);
        if (!context.ok) throw new Error(context.error.detail);
        const workers = selectCohortWorkerRecords(context.value);
        return { cohort_id: unit.cohort_id as CohortId, unit_id: unit.unit_id as UnitId,
          ...selectCohortRepositoryView(context.value, stage.stage_instance_id as StageInstanceId), brief: unit.brief,
          workers, version: context.value.cohort.version,
          sid: unit.session_id,
          state: unit.state, status: unit.status, blocked_reason: unit.blocked_reason, next_actor: unit.next_actor,
          retryable: workers.some((worker) => worker.record.state === "interrupted"), gate: null };
      }));
      const artifacts = artifactRows.filter((artifact) => artifact.stage_instance_id === stage.stage_instance_id)
        .map((artifact): OperatorStageArtifact => ({ id: artifact.id as ArtifactId, type_id: artifact.type_id, version: artifact.version, label: artifact.label, created_at: artifact.created_at }));
      return { stage_instance_id: stage.stage_instance_id as import("../domain/primitives").StageInstanceId,
        name: stage.name, type: stage.stage_type, operator_role: stage.operator_role,
        status: stage.status, blocked_reason: stage.blocked_reason, next_actor: stage.next_actor, artifacts,
        delegated_kbbl_sid: units.find((unit) => unit.sid)?.sid ?? null, worktree: null, units };
    }));
    // spec §3.6: a stage's `stage_instance` row exists only once it is ready,
    // so `detail.stages` synthesizes a `"pending"` entry for every definition
    // stage that has none yet — a dedicated single-row lookup, not folded into
    // `listV2RunSummaries`, so listing many runs never pays for compiling a
    // definition it does not need.
    const definitionRows = await this.sql.query<{ readonly definition: unknown }>(
      `SELECT definition.definition FROM oakridge.workflow_run run
       JOIN oakridge.workflow_definition definition ON definition.id=run.workflow_definition_id
       WHERE run.id=$1`, [id]);
    const definitionJson = definitionRows[0]?.definition;
    const pendingStages: OperatorStageDetail[] = [];
    if (definitionJson !== undefined) {
      // Definitions are validated when seeded (immutable per name+version), so
      // a stored definition that fails to parse or compile here is an
      // exception, not a value this projection degrades gracefully around.
      const parsedDefinition = parseV15WorkflowDefinition(definitionJson);
      if (!parsedDefinition.ok) throw new Error(`run ${id}'s stored workflow definition is invalid: ${parsedDefinition.error.detail}`);
      const storedStageKeys = new Set(stageRows.map((stage) => stage.name));
      for (const stage_key of selectV15StageOrder(parsedDefinition.value).filter((key) => !storedStageKeys.has(key))) {
        pendingStages.push({ stage_instance_id: stageInstanceIdFor(id, stage_key), name: stage_key,
          type: stage_key === "repository_preparation" ? "provision_repository_refs" : "delegated_session",
          operator_role: null, status: "pending", blocked_reason: null, next_actor: "core",
          artifacts: [], delegated_kbbl_sid: null, worktree: null, units: [] });
      }
    }
    return { id: summary.id, title: summary.title, repository_keys: summary.repository_keys, workflow_name: summary.workflow_name, current_attempt_root_workflow_id: summary.current_attempt_root_workflow_id,
      attempts: [], status: summary.status, blocked_reason: summary.blocked_reason, next_actor: summary.next_actor,
      stages: [...stages, ...pendingStages], parked_count: summary.parked_count, updated_at: summary.updated_at };
  }

  async get_run_diagnosis(id: WorkflowRunId): Promise<OperatorRunDiagnosis | null> {
    const baseRun = await this.getV2Run(id);
    if (!baseRun) return null;
    let run = baseRun;
    for (const contributor of this.cohort_detail_contributors.values()) {
      if (contributor.enrich_run) run = await contributor.enrich_run(run);
    }
    const sessionRows = await this.sql.query<DiagnosisSessionRow>(
      `SELECT session.kbbl_session_id AS session_id,stage.stage_key,attempt.cohort_id::text,cohort.cohort_key,
              intent.worker,intent.id::text AS execution_id,intent.action_point,
              worker.active_execution_id=intent.id AS is_current,
              session.status,session.created_at::text
       FROM oakridge.session session
       JOIN oakridge.attempt attempt ON attempt.id=session.attempt_id
       JOIN oakridge.execution_intent intent ON intent.attempt_id=attempt.id
       JOIN oakridge.cohort_worker worker ON worker.cohort_id=intent.cohort_id AND worker.worker=intent.worker
       JOIN oakridge.cohort cohort ON cohort.id=attempt.cohort_id
       JOIN oakridge.stage_instance stage ON stage.id=session.stage_instance_id
       WHERE session.run_id=$1 AND session.kbbl_session_id IS NOT NULL
       ORDER BY session.created_at,session.id`, [id]);
    const sessions: OperatorRunDiagnosisSession[] = sessionRows.map((row) => ({
      session_id: row.session_id, stage_key: row.stage_key, cohort_id: row.cohort_id as CohortId, cohort_key: row.cohort_key,
      worker: row.worker, execution_id: row.execution_id, action_point: row.action_point, is_current: row.is_current, status: row.status,
    }));
    const current_session = [...sessions].reverse().find((session) => session.status === "active" && session.is_current) ?? null;
    const awaitingWorkers = new Set(run.stages.flatMap((stage) => stage.units.flatMap((unit) => unit.workers
      .filter((worker) => worker.record.state === "awaiting_review" || worker.record.state === "interrupted")
      .map((worker) => `${unit.cohort_id}:${worker.worker}`))));
    const sessions_awaiting_action = sessions.filter((session) => session.is_current
      && awaitingWorkers.has(`${session.cohort_id}:${session.worker}`));
    const gates = await this.listV2PendingGates(id);
    const active_gates = gates.map((gate) => {
      const stage = run.stages.find((candidate) => candidate.stage_instance_id === gate.stage_instance_id);
      const cohort_id = stage?.units.find((unit) => unit.unit_id === gate.unit_id)?.cohort_id ?? null;
      return { ...gate, cohort_id };
    });
    const recent_artifacts = run.stages.flatMap((stage) => stage.artifacts.map((artifact) => ({
      artifact_id: artifact.id, type_id: artifact.type_id, revision: artifact.version, stage_name: stage.name,
      label: artifact.label, created_at: artifact.created_at,
    }))).sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)).slice(0, 8);
    const progress = { total: run.stages.length, pending: 0, active: 0, blocked: 0, complete: 0, failed: 0, cancelled: 0 };
    for (const stage of run.stages) progress[stage.status] += 1;
    const pull_request_merge_waits = selectPullRequestMergeWaits(await this.listV2Cohorts(id));
    return { run, sessions, current_session, sessions_awaiting_action, active_gates, pull_request_merge_waits, recent_artifacts, stage_progress: progress };
  }

  async get_review_inbox(): Promise<OperatorReviewInbox> {
    const [allGates, runs, projectedCohorts] = await Promise.all([this.listV2PendingGates(undefined, true), this.list_runs(), this.list_cohorts()]);
    // Omitted attention on legacy gate slots defaults to required. Optional
    // and silent gates remain visible on the run through list_pending_gates.
    // The inbox is the operator's decision queue. A gate stranded by a run
    // that has ended is still listed by `list_pending_gates` (spec §3.7) and
    // rendered on the run, but no decision on it can take effect, so it is
    // not queued here as work.
    const gates = allGates.filter((gate) => gate.actionable);
    const names = new Map(runs.map((run) => [run.id, run.workflow_name]));
    const cohorts = projectedCohorts.map((cohort): OperatorCohortSummary => {
      const gate = gates.find((candidate) => candidate.run_id === cohort.run_id && candidate.stage_instance_id === cohort.stage_instance_id && candidate.unit_id === cohort.unit_id);
      if (!gate) return cohort;
      return { ...cohort, artifact_revision_id: gate.artifact_revision_id ?? cohort.artifact_revision_id,
        artifact_url: gate.artifact_revision_id ? `/artifact_details/${gate.artifact_revision_id}` : cohort.artifact_url,
        gate_id: gate.id, gate_url: null,
        links: gate.pr_url ? [...cohort.links, { key: "gate", label: "Open review", url: gate.pr_url }] : cohort.links };
    });
    const items: OperatorReviewInboxItem[] = gates.filter((gate) => gate.stage_instance_id !== null).map((gate) => {
      const isMerge = gate.gate_step === "merge_confirmation";
      const cohort = cohorts.find((candidate) => candidate.run_id === gate.run_id && candidate.stage_instance_id === gate.stage_instance_id && candidate.unit_id === gate.unit_id);
      return {
        id: `gate:${gate.id}:${gate.gate_step ?? "unknown"}`,
        kind: isMerge ? "merge_confirmation" : "artifact_gate", state: "actionable", run_id: gate.run_id,
        workflow_name: names.get(gate.run_id) ?? "unknown", stage_instance_id: gate.stage_instance_id as StageInstanceId,
        stage_name: gate.stage_name, unit_id: gate.unit_id, repository_key: cohort?.repository_key ?? gate.repository_key, title: cohort?.title ?? null,
        lifecycle: cohort?.lifecycle ?? "blocked", blocked_reason: cohort?.blocked_reason ?? "gate", next_actor: cohort?.next_actor ?? "operator",
        artifact_revision_id: gate.artifact_revision_id,
        artifact_revision_ids: gate.artifact_revision_ids,
        artifact_url: gate.artifact_revision_id ? `/artifact_details/${gate.artifact_revision_id}` : null,
        gate_id: gate.id, gate_url: null, resume_actions: gate.resume_actions, blocked_by: [], pr_url: gate.pr_url,
      };
    });
    for (const cohort of cohorts) {
      const kind = cohort.lifecycle === "failed" ? "cohort_failed"
        : cohort.lifecycle === "blocked" && cohort.blocked_reason === "retry" && cohort.next_actor === "operator" ? "cohort_retry"
        : cohort.lifecycle === "blocked" && cohort.next_actor !== "operator" && cohort.next_actor !== "external" ? "cohort_blocked" : null;
      if (!kind) continue;
      items.push({ id: `${cohort.id}:${kind}`, kind, state: kind === "cohort_retry" ? "actionable" : "blocked", run_id: cohort.run_id, workflow_name: cohort.workflow_name,
        stage_instance_id: cohort.stage_instance_id, stage_name: cohort.stage_name, unit_id: cohort.unit_id,
        repository_key: cohort.repository_key, title: cohort.title, lifecycle: cohort.lifecycle,
        blocked_reason: cohort.blocked_reason, next_actor: cohort.next_actor,
        artifact_revision_id: cohort.artifact_revision_id, artifact_url: cohort.artifact_url, gate_id: cohort.gate_id,
        gate_url: cohort.gate_url, resume_actions: kind === "cohort_retry" ? ["retry"] : [], blocked_by: cohort.blocked_by, pr_url: cohort.links.find((link) => link.key === "pull_request")?.url ?? null });
    }
    // A cohort waiting on its pull request to merge is work, and it used to
    // appear nowhere in this list — the run sat on an external wait that no
    // surface offered a way to close. The poller normally closes it; the item
    // is `actionable` because an operator has to be able to when it cannot.
    for (const wait of selectPullRequestMergeWaits(cohorts)) {
      const cohort = cohorts.find((candidate) => candidate.id === wait.cohort_id);
      if (!cohort) continue;
      items.push({ id: `${cohort.id}:pull_request_merge`, kind: "pull_request_merge", state: "actionable", run_id: cohort.run_id,
        workflow_name: cohort.workflow_name, stage_instance_id: cohort.stage_instance_id, stage_name: cohort.stage_name,
        unit_id: cohort.unit_id, repository_key: cohort.repository_key, title: cohort.title, lifecycle: cohort.lifecycle,
        blocked_reason: cohort.blocked_reason, next_actor: cohort.next_actor,
        artifact_revision_id: cohort.artifact_revision_id, artifact_url: cohort.artifact_url, gate_id: null,
        gate_url: null, resume_actions: ["confirm_merged"], blocked_by: [], pr_url: cohort.links.find((link) => link.key === "pull_request")?.url ?? null });
    }
    return { cohorts, items, attention_count: items.filter((item) => item.state === "actionable").length };
  }

  async list_cohorts(): Promise<readonly OperatorCohortSummary[]> {
    return this.listV2Cohorts();
  }

  private async listV2Cohorts(run_id: WorkflowRunId | null = null): Promise<readonly OperatorCohortSummary[]> {
    const rows = await this.sql.query<V2CohortProjectionRow>(`SELECT cohort.id::text AS cohort_id,run.id::text AS run_id,
      definition.name AS workflow_name,stage.id::text AS stage_instance_id,stage.stage_key AS stage_name,
      cohort.cohort_key AS unit_id,cohort.status,cohort.blocked_reason,cohort.next_actor,
      artifact.id::text AS artifact_revision_id,
      stage.stage_type,brief.body->>'title' AS title,
      GREATEST(cohort.created_at,COALESCE(cohort.ended_at,cohort.created_at),COALESCE(artifact.created_at,cohort.created_at))::text AS updated_at
      FROM oakridge.cohort cohort JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
      JOIN oakridge.workflow_run run ON run.id=cohort.run_id JOIN oakridge.workflow_definition definition ON definition.id=run.workflow_definition_id
      LEFT JOIN LATERAL (SELECT candidate.* FROM oakridge.artifact candidate
        JOIN oakridge.artifact_owner owner ON owner.artifact_id=candidate.id
        WHERE owner.cohort_id=cohort.id AND candidate.lifecycle IN ('current','released')
        ORDER BY candidate.created_at DESC LIMIT 1) artifact ON true
      LEFT JOIN oakridge.artifact brief ON brief.chain_id::text=cohort.frozen_inputs->'brief'->>'id'
        AND brief.revision=(cohort.frozen_inputs->'brief'->>'version')::integer
      WHERE run.archived=false AND ($1::uuid IS NULL OR run.id=$1) ORDER BY updated_at DESC`, [run_id]);
    const details = new Map<string, Awaited<ReturnType<CohortDetailContributor["read"]>>>();
    for (const [stage_type, contributor] of this.cohort_detail_contributors) {
      details.set(stage_type, await contributor.read(rows.filter((row) => row.stage_type === stage_type)
        .map((row) => row.cohort_id as CohortId)));
    }
    return Promise.all(rows.map(async (row) => {
      const context = await loadStageCohortContext(this.sql, row.cohort_id as CohortId, row.stage_name as StageKey);
      if (!context.ok) throw new Error(context.error.detail);
      const workers = selectCohortWorkerRecords(context.value);
      const needsRetry = workers.some((worker) => worker.record.state === "interrupted");
      const needsReview = workers.some((worker) => worker.record.state === "awaiting_review");
      const repository = selectCohortRepositoryView(context.value, row.stage_instance_id as StageInstanceId);
      const artifact = row.artifact_revision_id as ArtifactId | null;
      const title = row.title;
      const detail = details.get(row.stage_type)?.get(row.cohort_id as CohortId);
      return { id: row.cohort_id,run_id: row.run_id as WorkflowRunId,workflow_name: row.workflow_name,stage_instance_id: row.stage_instance_id as import("../domain/primitives").StageInstanceId,stage_name: row.stage_name,unit_id: row.unit_id as UnitId,repository_key: repository.repository_key,title,lifecycle: needsRetry || needsReview ? "blocked" : row.status,blocked_reason: needsRetry ? "retry" : needsReview ? "gate" : row.blocked_reason,next_actor: needsRetry || needsReview ? "operator" : row.next_actor,completion: { build_complete: context.value.stage === "implementation" && context.value.cohort.build.state === "accepted", assessment_complete: context.value.stage === "implementation" && context.value.cohort.assessment.state === "accepted" },blocked_by: [],artifact_revision_id: artifact,artifact_url: artifact ? `/artifact_details/${artifact}` : null,gate_id: null,gate_url: null,links: detail?.links ?? [],facts: detail?.facts ?? [],updated_at: row.updated_at };
    }));
  }
}
