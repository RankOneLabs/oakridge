import type { ArtifactId, UnitId, WorkflowRunId } from "../domain/primitives";
import type { OperatorApplicationVersionInventory, OperatorCohortLifecycle, OperatorCohortSummary, OperatorParkedGate, OperatorReviewInbox, OperatorReviewInboxItem, OperatorRunDetail, OperatorRunSummary, OperatorStageArtifact, OperatorStageDetail, OperatorStageUnit, OperatorWorkflowAttempt } from "../domain/operator-projections";
import type { SqlExecutor } from "./sql-executor";
import { selectRunStatus, selectStageStatus } from "../operators/select-status";
import type { EpicWorkflowProfile } from "../domain/epic";
import { STAGE_RERUN_STATE_KEY_PREFIX } from "../domain/rerun";
import { superjsonValueLateral } from "./sql-fragments";
import { TERMINAL_OBSERVER_SUFFIX } from "../domain/workflow-ids";
import { PR_SUMMARY_ARTIFACT_TYPE } from "../domain/dev-flow-artifacts";
import { selectHandoffStatusFromWait, type HandoffWaitKind, type Wait, type WaitOutcome } from "../domain/wait";
import type { StageOutcome } from "../domain/workflow";

interface GateProjectionRow {
  readonly run_id: string;
  readonly stage_name: string;
  readonly stage_instance_id: string;
  readonly unit_id: string;
  readonly artifact_revision_id: string;
  readonly gate_step: string;
  readonly actions: readonly string[];
}

export interface OperatorProjectionRepository {
  list_pending_gates(run_id?: WorkflowRunId): Promise<readonly OperatorParkedGate[]>;
  list_runs(filter?: "active" | "archived" | "all"): Promise<readonly OperatorRunSummary[]>;
  get_run(id: WorkflowRunId): Promise<OperatorRunDetail | null>;
  get_review_inbox(): Promise<OperatorReviewInbox>;
  /**
   * The raw cohort projection, without the review inbox's gate overlay. The
   * pull-request poller wants the handoff's own state, not the operator-facing
   * lifecycle the inbox blends a pending gate into.
   */
  list_cohorts(): Promise<readonly OperatorCohortSummary[]>;
  set_run_archived(id: WorkflowRunId, archived: boolean): Promise<boolean>;
  get_invalidation_cursor(): Promise<string>;
  list_application_versions(): Promise<readonly OperatorApplicationVersionInventory[]>;
}

interface RunProjectionRow { readonly id: string; readonly workflow_name: string; readonly root_workflow_id: string; readonly dbos_status: string; readonly current_stage: string | null; readonly parked_count: string; readonly updated_at_epoch_ms: string; readonly outcome: StageOutcome | null; readonly is_stuck: boolean; readonly archived: boolean }
interface AttemptProjectionRow { readonly root_workflow_id: string; readonly forked_from_root_workflow_id: string | null; readonly dbos_status: string; readonly created_at: string; readonly parked_count: string; readonly outcome: StageOutcome | null }
interface StageProjectionRow { readonly stage_instance_id: string; readonly name: string; readonly stage_type: string; readonly operator_role: string | null; readonly dbos_status: string; readonly has_pending_gate: boolean; readonly outcome: StageOutcome | null }
interface UnitProjectionRow { readonly stage_instance_id: string; readonly unit_id: string; readonly params: OperatorStageUnit["params"]; readonly external_reference: { readonly kind?: string; readonly session_id?: string; readonly worktree_base_sha?: string } | null; readonly dbos_status: string; readonly has_pending_gate: boolean; readonly admission_required: boolean; readonly admitted: boolean; readonly admission_eligible: boolean; readonly admission_blocked_by: readonly string[] }
interface StageArtifactRow { readonly stage_instance_id: string; readonly id: string; readonly type_id: string; readonly version: number; readonly label: string | null }
interface EpicProfileRow extends Omit<EpicWorkflowProfile, "id" | "workflow_run_id"> { readonly id: string; readonly workflow_run_id: string }
/**
 * A fan-out unit's parameters are the item the stage fanned out over, wrapped.
 *
 * `materializeUnits` stores the whole envelope — `{unit_id, artifact}` for an
 * artifact-driven fan-out — so a cohort's own fields sit under `artifact`, not
 * at the top. This row type used to claim they were top-level, and the fake
 * executor in the projection tests supplied them that way, so the type and its
 * test agreed with each other and both disagreed with every real row.
 */
interface CohortUnitParameters { readonly artifact?: { readonly repository_key?: string; readonly title?: string } | null }
interface CohortProjectionRow { readonly run_id: string; readonly workflow_name: string; readonly stage_instance_id: string; readonly stage_name: string; readonly unit_id: string; readonly params: CohortUnitParameters | null; readonly dbos_status: string; readonly artifact_revision_id: string | null; readonly handoff_wait_kind: HandoffWaitKind | null; readonly handoff_wait_status: Wait["status"]["kind"] | null; readonly handoff_outcome_kind: WaitOutcome["kind"] | null; readonly summary_pr_url: string | null; readonly reconciliation: OperatorCohortSummary["pull_request_reconciliation"]; readonly updated_at_epoch_ms: string; readonly admission_required: boolean; readonly admitted: boolean; readonly admission_eligible: boolean; readonly admission_blocked_by: readonly string[] }

const decodeGate = (row: GateProjectionRow): OperatorParkedGate => ({
  id: `${row.stage_instance_id}:${row.unit_id}`,
  gate_type: row.gate_step,
  run_id: row.run_id as WorkflowRunId,
  stage_name: row.stage_name,
  unit_id: row.unit_id as UnitId,
  repository_key: null,
  artifact_revision_id: row.artifact_revision_id as ArtifactId,
  gate_step: row.gate_step,
  worktree: null,
  resume_actions: row.actions,
  pr_url: null,
});

/**
 * How long a live run may make no recorded progress before the projection
 * reports it stuck. Matches the Rust core's `stage_timeout_secs` default, which
 * this backend replaced.
 */
export const DEFAULT_STALL_THRESHOLD_SECONDS = 3600;

export interface OperatorProjectionOptions {
  readonly stall_threshold_seconds?: number;
}

export class PostgresOperatorProjectionRepository implements OperatorProjectionRepository {
  private readonly stallThresholdSeconds: number;

  constructor(private readonly sql: SqlExecutor, options: OperatorProjectionOptions = {}) {
    this.stallThresholdSeconds = options.stall_threshold_seconds ?? DEFAULT_STALL_THRESHOLD_SECONDS;
  }

  async list_pending_gates(run_id?: WorkflowRunId): Promise<readonly OperatorParkedGate[]> {
    const rows = await this.sql.query<GateProjectionRow>(
      `SELECT stage.run_id::text,
              stage.stage_key AS stage_name,
              wait.stage_instance_id::text,
              wait.unit_id,
              wait.artifact_revision_id::text,
              wait.closes_on->>'gate_step' AS gate_step,
              COALESCE(ARRAY(SELECT jsonb_array_elements_text(wait.closes_on->'actions')), ARRAY[]::text[]) AS actions
       FROM oakridge.wait wait
       JOIN oakridge.stage_instance stage ON stage.id = wait.stage_instance_id
       JOIN oakridge.workflow_run run ON run.id = stage.run_id
       JOIN oakridge.artifact artifact ON artifact.id = wait.artifact_revision_id
       WHERE wait.kind = 'gate'
         AND wait.status = 'open'
         -- Archiving a run is the operator saying they are done with it. A gate
         -- it left pending is not work they still owe, and listing it anyway is
         -- how an inbox fills with decisions nobody intends to make.
         AND run.archived = false
         AND artifact.lifecycle_state = 'current'
         AND stage.attempt_root_workflow_id = (
           SELECT attempt.root_workflow_id FROM oakridge.workflow_attempt attempt
           WHERE attempt.run_id = stage.run_id ORDER BY attempt.created_at DESC LIMIT 1)
         AND ($1::uuid IS NULL OR stage.run_id = $1::uuid)
       ORDER BY stage.started_at, wait.unit_id`,
      [run_id ?? null],
    );
    return rows.map(decodeGate);
  }

  async list_runs(filter: "active" | "archived" | "all" = "active"): Promise<readonly OperatorRunSummary[]> {
    return this.listRunSummaries(filter, null);
  }

  /**
   * One summary query for both the list and the single-run detail. `get_run`
   * used to build every run's summary — stall detection, parked-gate counts and
   * all — and then discard all but one with `.find()`.
   */
  private async listRunSummaries(filter: "active" | "archived" | "all", run_id: WorkflowRunId | null): Promise<readonly OperatorRunSummary[]> {
    const rows = await this.sql.query<RunProjectionRow>(
      `SELECT run.id::text,
              definition.name AS workflow_name,
              root.root_workflow_id,
              root.status AS dbos_status,
              current_stage.stage_key AS current_stage,
              COALESCE(gates.parked_count, 0)::text AS parked_count,
              GREATEST(root.updated_at, COALESCE(current_stage.updated_at_epoch_ms, 0))::text AS updated_at_epoch_ms,
              root.outcome,
              COALESCE(stuck.is_stuck, false) AS is_stuck,
              run.archived
       FROM oakridge.workflow_run run
       JOIN oakridge.workflow_definition definition ON definition.id = run.workflow_definition_id
       JOIN LATERAL (
         SELECT attempt.root_workflow_id, status.status, status.updated_at, attempt.outcome
         FROM oakridge.workflow_attempt attempt
         JOIN dbos.workflow_status status ON status.workflow_uuid = attempt.root_workflow_id
         WHERE attempt.run_id = run.id
         ORDER BY attempt.created_at DESC LIMIT 1
       ) root ON true
       LEFT JOIN LATERAL (
         SELECT stage.stage_key, stage_status.updated_at AS updated_at_epoch_ms
         FROM oakridge.stage_instance stage
         JOIN dbos.workflow_status stage_status ON stage_status.workflow_uuid = stage.coordinator_workflow_id
         WHERE stage.run_id = run.id AND stage.attempt_root_workflow_id = root.root_workflow_id AND stage.ended_at IS NULL
         ORDER BY stage.started_at DESC LIMIT 1
       ) current_stage ON true
       LEFT JOIN LATERAL (
         SELECT root.outcome IS NULL AND (EXISTS (
           -- A unit is parked waiting for an operator to authorise a rerun.
           SELECT 1
           FROM oakridge.stage_instance stage
           JOIN dbos.workflow_events event
             ON event.workflow_uuid = stage.coordinator_workflow_id AND event.key LIKE '${STAGE_RERUN_STATE_KEY_PREFIX}%'
           ${superjsonValueLateral("event.value", "rerun")}
           WHERE stage.run_id = run.id AND stage.attempt_root_workflow_id = root.root_workflow_id
             AND rerun.value->>'status' = 'waiting'
         ) OR EXISTS (
           -- A terminal observer died, so this unit's completion can never be
           -- reported and its execution workflow waits forever.
           SELECT 1
           FROM oakridge.stage_instance stage
           JOIN oakridge.executor_projection projection ON projection.stage_instance_id = stage.id
           JOIN dbos.workflow_status observer
             ON observer.workflow_uuid = projection.execution_workflow_id || '${TERMINAL_OBSERVER_SUFFIX}'
           WHERE stage.run_id = run.id AND stage.attempt_root_workflow_id = root.root_workflow_id
             AND observer.status IN ('ERROR', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED')
         ) OR (
           -- Nothing has advanced this run for longer than the stall window.
           -- Catches the stalls that produce no error and no rerun state at
           -- all: a coordinator that stopped between steps, or a backend that
           -- is not running to recover it.
           GREATEST(root.updated_at, COALESCE(current_stage.updated_at_epoch_ms, 0))
             < (extract(epoch FROM now()) - $2::double precision) * 1000
         )) AS is_stuck
       ) stuck ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS parked_count
         FROM oakridge.wait wait
         JOIN oakridge.stage_instance stage ON stage.id = wait.stage_instance_id
         JOIN oakridge.artifact artifact ON artifact.id = wait.artifact_revision_id
         WHERE wait.kind = 'gate' AND wait.status = 'open' AND artifact.lifecycle_state = 'current' AND stage.run_id = run.id
           AND stage.attempt_root_workflow_id = root.root_workflow_id
       ) gates ON true
       WHERE ($1::boolean IS NULL OR run.archived = $1::boolean)
         AND ($3::uuid IS NULL OR run.id = $3::uuid)
       ORDER BY root.updated_at DESC`,
      [filter === "all" ? null : filter === "archived", this.stallThresholdSeconds, run_id],
    );
    return rows.map((row) => {
      const parked_count = Number(row.parked_count);
      const status = selectRunStatus(row.dbos_status, parked_count, row.outcome);
      return { id: row.id as WorkflowRunId, workflow_name: row.workflow_name, current_attempt_root_workflow_id: row.root_workflow_id, status, current_stage: row.current_stage, parked_count, updated_at: new Date(Number(row.updated_at_epoch_ms)).toISOString(), is_stuck: row.is_stuck, is_failed: status === "failed", archived: row.archived };
    });
  }

  async set_run_archived(id: WorkflowRunId, archived: boolean): Promise<boolean> {
    const rows = await this.sql.query<{ readonly id: string }>(
      `UPDATE oakridge.workflow_run SET archived = $2 WHERE id = $1 RETURNING id::text`,
      [id, archived],
    );
    return rows.length === 1;
  }

  async get_invalidation_cursor(): Promise<string> {
    const rows = await this.sql.query<{ readonly cursor: string }>(
      `SELECT concat_ws(':',
         COALESCE((SELECT max(updated_at)::text FROM dbos.workflow_status), '0'),
         COALESCE((SELECT max(lifecycle_updated_at)::text FROM oakridge.artifact), '0'),
         COALESCE((SELECT max(created_at)::text FROM oakridge.gate_decision_audit), '0'),
         COALESCE((SELECT max(updated_at)::text FROM oakridge.executor_projection), '0'),
         COALESCE((SELECT max(updated_at)::text FROM oakridge.epic_workflow_profile), '0'),
         COALESCE((SELECT max(created_at)::text FROM oakridge.collaboration_message), '0'),
         COALESCE((SELECT max(created_at)::text FROM oakridge.review_item), '0')) AS cursor`, []);
    return rows[0]?.cursor ?? "0";
  }

  async list_application_versions(): Promise<readonly OperatorApplicationVersionInventory[]> {
    const rows = await this.sql.query<{ readonly application_version: string | null; readonly run_count: string; readonly pending_run_count: string; readonly gated_run_count: string; readonly oldest_pending_epoch_ms: string | null }>(
      `SELECT status.application_version,
              count(*)::text AS run_count,
              count(*) FILTER (WHERE status.status IN ('PENDING', 'ENQUEUED', 'DELAYED'))::text AS pending_run_count,
              count(*) FILTER (WHERE gates.has_pending_gate)::text AS gated_run_count,
              min(status.created_at) FILTER (WHERE status.status IN ('PENDING', 'ENQUEUED', 'DELAYED'))::text AS oldest_pending_epoch_ms
       FROM oakridge.workflow_attempt attempt
       JOIN dbos.workflow_status status ON status.workflow_uuid = attempt.root_workflow_id
       LEFT JOIN LATERAL (
         SELECT EXISTS (
           SELECT 1 FROM oakridge.wait wait
           JOIN oakridge.stage_instance stage ON stage.id = wait.stage_instance_id
           JOIN oakridge.artifact artifact ON artifact.id = wait.artifact_revision_id
           WHERE wait.kind = 'gate' AND wait.status = 'open' AND artifact.lifecycle_state = 'current'
             AND stage.attempt_root_workflow_id = attempt.root_workflow_id
         ) AS has_pending_gate
       ) gates ON true
       GROUP BY status.application_version
       ORDER BY oldest_pending_epoch_ms NULLS LAST`, []);
    return rows.map((row) => ({ application_version: row.application_version, run_count: Number(row.run_count), pending_run_count: Number(row.pending_run_count), gated_run_count: Number(row.gated_run_count), oldest_pending_at: row.oldest_pending_epoch_ms === null ? null : new Date(Number(row.oldest_pending_epoch_ms)).toISOString() }));
  }

  async get_run(id: WorkflowRunId): Promise<OperatorRunDetail | null> {
    const summary = (await this.listRunSummaries("all", id))[0];
    if (!summary) return null;
    const stageRows = await this.sql.query<StageProjectionRow>(
      `SELECT stage.id::text AS stage_instance_id, stage.stage_key AS name, stage.stage_type,
              stage.stage_contract->>'operator_role' AS operator_role, status.status AS dbos_status, stage.outcome,
              EXISTS (SELECT 1 FROM oakridge.wait wait JOIN oakridge.artifact artifact ON artifact.id = wait.artifact_revision_id WHERE wait.kind = 'gate' AND wait.status = 'open' AND artifact.lifecycle_state = 'current' AND wait.stage_instance_id = stage.id) AS has_pending_gate
       FROM oakridge.stage_instance stage JOIN dbos.workflow_status status ON status.workflow_uuid = stage.coordinator_workflow_id
       WHERE stage.run_id = $1 AND stage.attempt_root_workflow_id = $2 ORDER BY stage.started_at`, [id, summary.current_attempt_root_workflow_id]);
    const unitRows = await this.sql.query<UnitProjectionRow>(
      `SELECT stage.id::text AS stage_instance_id, unit.value->>'unit_id' AS unit_id,
              COALESCE(projection.unit_parameters, unit.value->'parameters') AS params,
              projection.external_reference, COALESCE(status.status, 'PENDING') AS dbos_status,
              COALESCE((admission.value->>'manual_admission')::boolean, false) AS admission_required,
              COALESCE((unit.value->>'admitted')::boolean, true) AS admitted,
              COALESCE((unit.value->>'eligible')::boolean, true) AS admission_eligible,
              COALESCE(ARRAY(SELECT jsonb_array_elements_text(unit.value->'blocked_by')), ARRAY[]::text[]) AS admission_blocked_by,
              EXISTS (SELECT 1 FROM oakridge.wait wait JOIN oakridge.artifact artifact ON artifact.id = wait.artifact_revision_id WHERE wait.kind = 'gate' AND wait.status = 'open' AND artifact.lifecycle_state = 'current' AND wait.stage_instance_id = stage.id AND wait.unit_id = unit.value->>'unit_id') AS has_pending_gate
       FROM oakridge.stage_instance stage
       JOIN dbos.workflow_events admission_event ON admission_event.workflow_uuid = stage.coordinator_workflow_id AND admission_event.key = 'stage-admission-state'
       ${superjsonValueLateral("admission_event.value", "admission")}
       CROSS JOIN LATERAL jsonb_array_elements(admission.value->'units') unit(value)
       LEFT JOIN oakridge.executor_projection projection ON projection.stage_instance_id = stage.id AND projection.unit_id = unit.value->>'unit_id'
       LEFT JOIN dbos.workflow_status status ON status.workflow_uuid = projection.execution_workflow_id
       WHERE stage.run_id = $1 AND stage.attempt_root_workflow_id = $2 ORDER BY projection.stage_instance_id, projection.unit_id`, [id, summary.current_attempt_root_workflow_id]);
    const artifactRows = await this.sql.query<StageArtifactRow>(
      `SELECT DISTINCT ON (artifact.stage_instance_id, artifact.execution_id, artifact.unit_id, artifact.output_name)
              artifact.stage_instance_id::text, artifact.id::text, artifact.artifact_type AS type_id, artifact.version, artifact.label
       FROM oakridge.artifact artifact WHERE artifact.run_id = $1 AND artifact.lifecycle_state IN ('current', 'released')
       ORDER BY artifact.stage_instance_id, artifact.execution_id, artifact.unit_id, artifact.output_name, artifact.version DESC`, [id]);
    const profileRows = await this.sql.query<EpicProfileRow>(
      `SELECT id::text, workflow_run_id::text, title, slug, lifecycle_state, final_merge_policy,
              base_branch, repositories, created_at::text, updated_at::text
       FROM oakridge.epic_workflow_profile WHERE workflow_run_id = $1`, [id]);
    const stages: OperatorStageDetail[] = stageRows.map((stage) => {
      const units: OperatorStageUnit[] = unitRows.filter((unit) => unit.stage_instance_id === stage.stage_instance_id).map((unit) => ({
        unit_id: unit.unit_id as UnitId, repository_key: null, params: unit.params, sid: unit.external_reference?.kind === "kbbl_session" ? unit.external_reference.session_id ?? null : null,
        worktree: null, base_sha: unit.external_reference?.worktree_base_sha ?? null, status: selectStageStatus(unit.dbos_status, unit.has_pending_gate), gate: unit.has_pending_gate ? "artifact_approval" : null,
        admission_required: unit.admission_required, admitted: unit.admitted, admission_eligible: unit.admission_eligible, admission_blocked_by: unit.admission_blocked_by,
      }));
      const artifacts: OperatorStageArtifact[] = artifactRows.filter((artifact) => artifact.stage_instance_id === stage.stage_instance_id).map((artifact) => ({ id: artifact.id as ArtifactId, type_id: artifact.type_id, version: artifact.version, label: artifact.label }));
      const delegated = units.find((unit) => unit.sid)?.sid ?? null;
      return { stage_instance_id: stage.stage_instance_id as import("../domain/primitives").StageInstanceId, name: stage.name, type: stage.stage_type, operator_role: stage.operator_role, status: selectStageStatus(stage.dbos_status, stage.has_pending_gate, stage.outcome), artifacts, delegated_kbbl_sid: delegated, worktree: null, units };
    });
    const profile = profileRows[0];
    const attemptRows = await this.sql.query<AttemptProjectionRow>(
      `SELECT attempt.root_workflow_id, attempt.forked_from_root_workflow_id,
              status.status AS dbos_status, attempt.created_at::text, attempt.outcome,
              count(wait.id) FILTER (WHERE gate_artifact.lifecycle_state = 'current')::text AS parked_count
       FROM oakridge.workflow_attempt attempt
       JOIN dbos.workflow_status status ON status.workflow_uuid = attempt.root_workflow_id
       LEFT JOIN oakridge.stage_instance stage ON stage.attempt_root_workflow_id = attempt.root_workflow_id
       LEFT JOIN oakridge.wait wait ON wait.stage_instance_id = stage.id AND wait.kind = 'gate' AND wait.status = 'open'
       LEFT JOIN oakridge.artifact gate_artifact ON gate_artifact.id = wait.artifact_revision_id
       WHERE attempt.run_id = $1
       GROUP BY attempt.root_workflow_id, attempt.forked_from_root_workflow_id, status.status, attempt.created_at, attempt.outcome
       ORDER BY attempt.created_at`, [id]);
    const attempts: OperatorWorkflowAttempt[] = attemptRows.map((attempt) => ({ root_workflow_id: attempt.root_workflow_id,
      forked_from_root_workflow_id: attempt.forked_from_root_workflow_id,
      status: selectRunStatus(attempt.dbos_status, Number(attempt.parked_count), attempt.outcome), created_at: attempt.created_at }));
    const epic_profile: EpicWorkflowProfile | null = profile ? {
      ...profile,
      id: profile.id as EpicWorkflowProfile["id"],
      workflow_run_id: profile.workflow_run_id as WorkflowRunId,
    } : null;
    return { id: summary.id, workflow_name: summary.workflow_name, current_attempt_root_workflow_id: summary.current_attempt_root_workflow_id,
      attempts, status: summary.status, stages, parked_count: summary.parked_count, updated_at: summary.updated_at, is_stuck: summary.is_stuck, epic_profile };
  }

  async get_review_inbox(): Promise<OperatorReviewInbox> {
    const [gates, runs, projectedCohorts] = await Promise.all([this.list_pending_gates(), this.list_runs(), this.list_cohorts()]);
    const names = new Map(runs.map((run) => [run.id, run.workflow_name]));
    const cohorts = projectedCohorts.map((cohort): OperatorCohortSummary => {
      const gate = gates.find((candidate) => candidate.run_id === cohort.run_id && candidate.unit_id === cohort.unit_id);
      if (!gate) return cohort;
      const lifecycle: OperatorCohortLifecycle = gate.gate_step === "merge_confirmation" ? "merge_confirmation" : "artifact_review";
      return { ...cohort, lifecycle, artifact_revision_id: gate.artifact_revision_id ?? cohort.artifact_revision_id,
        artifact_url: gate.artifact_revision_id ? `/artifact_details/${gate.artifact_revision_id}` : cohort.artifact_url,
        gate_id: gate.id, gate_url: `/gates/${gate.id}/resume`, pr_url: gate.pr_url };
    });
    const items: OperatorReviewInboxItem[] = gates.map((gate) => {
      const isMerge = gate.gate_step === "merge_confirmation";
      const cohort = cohorts.find((candidate) => candidate.run_id === gate.run_id && candidate.unit_id === gate.unit_id);
      return {
        id: `gate:${gate.id}:${gate.artifact_revision_id ?? "none"}:${gate.gate_step ?? "unknown"}`,
        kind: isMerge ? "merge_confirmation" : "artifact_gate", state: "actionable", run_id: gate.run_id,
        workflow_name: names.get(gate.run_id) ?? "unknown", stage_instance_id: gate.id.slice(0, gate.id.indexOf(":")) as import("../domain/primitives").StageInstanceId,
        stage_name: gate.stage_name, unit_id: gate.unit_id, repository_key: cohort?.repository_key ?? gate.repository_key, title: cohort?.title ?? null,
        lifecycle: isMerge ? "merge_confirmation" : "artifact_review", artifact_revision_id: gate.artifact_revision_id,
        artifact_url: gate.artifact_revision_id ? `/artifact_details/${gate.artifact_revision_id}` : null,
        gate_id: gate.id, gate_url: `/oakridge/gates/${gate.id}`, resume_actions: gate.resume_actions, blocked_by: [], pr_url: gate.pr_url, completed_at: null,
      };
    });
    for (const cohort of cohorts) {
      const kind = cohort.lifecycle === "pull_request_mismatch" ? "pull_request_mismatch" : cohort.lifecycle === "failed" ? "cohort_failed" : null;
      if (!kind) continue;
      items.push({ id: `${cohort.id}:${kind}`, kind, state: "blocked", run_id: cohort.run_id, workflow_name: cohort.workflow_name,
        stage_instance_id: cohort.stage_instance_id, stage_name: cohort.stage_name, unit_id: cohort.unit_id,
        repository_key: cohort.repository_key, title: cohort.title, lifecycle: cohort.lifecycle,
        artifact_revision_id: cohort.artifact_revision_id, artifact_url: cohort.artifact_url, gate_id: cohort.gate_id,
        gate_url: cohort.gate_url, resume_actions: [], blocked_by: cohort.admission.blocked_by, pr_url: cohort.pr_url, completed_at: null });
    }
    // A cohort waiting on its pull request to merge is work, and it used to
    // appear nowhere in this list — the run sat on an external wait that no
    // surface offered a way to close. The poller normally closes it; the item
    // is `actionable` because an operator has to be able to when it cannot.
    for (const cohort of cohorts) {
      if (cohort.lifecycle !== "github_review") continue;
      items.push({ id: `${cohort.id}:pull_request_merge`, kind: "pull_request_merge", state: "actionable", run_id: cohort.run_id,
        workflow_name: cohort.workflow_name, stage_instance_id: cohort.stage_instance_id, stage_name: cohort.stage_name,
        unit_id: cohort.unit_id, repository_key: cohort.repository_key, title: cohort.title, lifecycle: cohort.lifecycle,
        artifact_revision_id: cohort.artifact_revision_id, artifact_url: cohort.artifact_url, gate_id: null,
        gate_url: null, resume_actions: ["confirm_merged"], blocked_by: [], pr_url: cohort.pr_url, completed_at: null });
    }
    return { cohorts, items };
  }

  async list_cohorts(): Promise<readonly OperatorCohortSummary[]> {
    const rows = await this.sql.query<CohortProjectionRow>(
      `SELECT stage.run_id::text, definition.name AS workflow_name, stage.id::text AS stage_instance_id,
              stage.stage_key AS stage_name, unit.value->>'unit_id' AS unit_id,
              COALESCE(projection.unit_parameters, unit.value->'parameters') AS params,
              COALESCE(execution.status, 'PENDING') AS dbos_status, artifact.id::text AS artifact_revision_id,
              COALESCE((admission.value->>'manual_admission')::boolean, false) AS admission_required,
              COALESCE((unit.value->>'admitted')::boolean, true) AS admitted,
              COALESCE((unit.value->>'eligible')::boolean, true) AS admission_eligible,
              COALESCE(ARRAY(SELECT jsonb_array_elements_text(unit.value->'blocked_by')), ARRAY[]::text[]) AS admission_blocked_by,
              handoff.kind AS handoff_wait_kind,
              handoff.status AS handoff_wait_status,
              handoff.outcome_kind AS handoff_outcome_kind,
              summary.pr_url AS summary_pr_url,
              CASE WHEN reconciliation.stage_instance_id IS NULL THEN NULL ELSE jsonb_build_object(
                'repository_key', reconciliation.repository_key, 'observation', reconciliation.observation,
                'mismatch', reconciliation.mismatch, 'completed_at', reconciliation.completed_at,
                'updated_at', reconciliation.updated_at) END AS reconciliation,
              COALESCE(execution.updated_at, extract(epoch FROM stage.started_at) * 1000)::text AS updated_at_epoch_ms
       FROM oakridge.stage_instance stage
       JOIN oakridge.workflow_run run ON run.id = stage.run_id
       JOIN LATERAL (SELECT attempt.root_workflow_id FROM oakridge.workflow_attempt attempt WHERE attempt.run_id = run.id ORDER BY attempt.created_at DESC LIMIT 1) current_attempt ON current_attempt.root_workflow_id = stage.attempt_root_workflow_id
       JOIN oakridge.workflow_definition definition ON definition.id = run.workflow_definition_id
       JOIN dbos.workflow_events admission_event ON admission_event.workflow_uuid = stage.coordinator_workflow_id AND admission_event.key = 'stage-admission-state'
       ${superjsonValueLateral("admission_event.value", "admission")}
       CROSS JOIN LATERAL jsonb_array_elements(admission.value->'units') unit(value)
       LEFT JOIN oakridge.executor_projection projection ON projection.stage_instance_id = stage.id AND projection.unit_id = unit.value->>'unit_id'
       LEFT JOIN dbos.workflow_status execution ON execution.workflow_uuid = projection.execution_workflow_id
       -- Which of the stage's outputs carries the handoff. A unit emits one
       -- artifact per output, and only this one has a handoff workflow named
       -- after it, so picking any other loses the cohort's entire state.
       CROSS JOIN LATERAL (
         SELECT output.value->>'name' AS output_name
         FROM jsonb_array_elements(stage.stage_contract->'outputs') AS output(value)
         WHERE output.value->'release'->>'kind' = 'handoff'
         ORDER BY output.value->>'name' LIMIT 1
       ) handoff_output
       LEFT JOIN LATERAL (
         SELECT candidate.* FROM oakridge.artifact candidate
         WHERE candidate.stage_instance_id = stage.id AND candidate.execution_id = projection.execution_id AND candidate.unit_id = projection.unit_id
           AND candidate.output_name = handoff_output.output_name
           AND candidate.lifecycle_state IN ('current', 'released')
         ORDER BY candidate.version DESC, candidate.id LIMIT 1
       ) artifact ON true
       -- Artifact-keyed, deliberately WITHOUT the execution predicate the
       -- command paths take: this lateral displays and sends nothing, and
       -- keying it to the projection's execution workflow id is exactly what
       -- lost a cohort — after a unit rerun the projection names the
       -- replacement, the lookup misses, and the cohort reads 'building'
       -- forever. External preferred when both handoff rows exist.
       LEFT JOIN LATERAL (
         SELECT wait.kind, wait.status, wait.outcome->>'kind' AS outcome_kind
         FROM oakridge.wait wait
         WHERE wait.artifact_revision_id = artifact.id
           AND wait.kind IN ('handoff_downstream', 'handoff_external')
         ORDER BY (wait.kind = 'handoff_external') DESC LIMIT 1
       ) handoff ON true
       -- The pull request the cohort opened, for an operator who has to be told
       -- *which* pull request to confirm. The reconciliation record is
       -- authoritative once one exists; before that the build's own summary is
       -- the only place the URL is written, which is where the reconciler reads
       -- it from too.
       LEFT JOIN LATERAL (
         SELECT candidate.body->>'pr_url' AS pr_url FROM oakridge.artifact candidate
         WHERE candidate.stage_instance_id = stage.id AND candidate.execution_id = projection.execution_id AND candidate.unit_id = projection.unit_id
           AND candidate.artifact_type = '${PR_SUMMARY_ARTIFACT_TYPE}'
           AND candidate.lifecycle_state IN ('current', 'released')
         ORDER BY candidate.version DESC, candidate.id LIMIT 1
       ) summary ON true
       LEFT JOIN oakridge.cohort_pull_request_reconciliation reconciliation
         ON reconciliation.stage_instance_id = stage.id AND reconciliation.unit_id = projection.unit_id
       -- A stage with no handoff output is not a cohort stage; the CROSS JOIN
       -- above drops it, which is the same filter the EXISTS used to apply.
       WHERE run.archived = false
       ORDER BY COALESCE(execution.updated_at, extract(epoch FROM stage.started_at) * 1000) DESC`, []);
    return rows.map((row) => {
      const handoff_status = row.handoff_wait_kind === null || row.handoff_wait_status === null
        ? null
        : selectHandoffStatusFromWait(row.handoff_wait_kind, row.handoff_wait_status, row.handoff_outcome_kind);
      const lifecycle: OperatorCohortLifecycle = row.dbos_status === "ERROR" ? "failed" : row.reconciliation?.mismatch ? "pull_request_mismatch" : handoff_status === "released" ? "complete" : handoff_status === "awaiting_external" ? "github_review" : handoff_status === "revision_requested" ? "revision_requested" : handoff_status === "awaiting_downstream" ? "assessing" : "building";
      const artifact = row.artifact_revision_id as ArtifactId | null;
      const cohort = row.params?.artifact ?? null;
      return { id: `${row.stage_instance_id}:${row.unit_id}`, run_id: row.run_id as WorkflowRunId, workflow_name: row.workflow_name, stage_instance_id: row.stage_instance_id as import("../domain/primitives").StageInstanceId, stage_name: row.stage_name, unit_id: row.unit_id as UnitId, repository_key: cohort?.repository_key ?? null, title: cohort?.title ?? null, lifecycle, completion: { build_complete: artifact !== null, assessment_complete: lifecycle === "complete" }, admission: { required: row.admission_required, admitted: row.admitted, eligible: row.admission_eligible, blocked_by: row.admission_blocked_by }, artifact_revision_id: artifact, artifact_url: artifact ? `/artifact_details/${artifact}` : null, gate_id: null, gate_url: null, pr_url: row.reconciliation?.observation.url ?? row.summary_pr_url ?? null, pull_request_reconciliation: row.reconciliation, updated_at: new Date(Number(row.updated_at_epoch_ms)).toISOString() };
    });
  }
}
