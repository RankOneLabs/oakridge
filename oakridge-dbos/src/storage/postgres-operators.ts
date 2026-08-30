import type { ArtifactId, RunUnitId, UnitId, WorkflowRunId, WorkOrderId } from "../domain/primitives";
import { selectGateActionability, selectPendingStageOrder, selectRunRecordUnitDecision, type OperatorApplicationVersionInventory, type OperatorCohortLifecycle, type OperatorCohortSummary, type OperatorParkedGate, type OperatorReviewInbox, type OperatorReviewInboxItem, type OperatorRunDetail, type OperatorRunRecordDetail, type OperatorRunRecordSlot, type OperatorRunRecordTransition, type OperatorRunRecordUnit, type OperatorRunRecordUnitFacts, type OperatorRunRecordWait, type OperatorRunRecordWorkOrder, type OperatorRunSummary, type OperatorStageArtifact, type OperatorStageDetail, type OperatorStageUnit } from "../domain/operator-projections";
import type { RunOutputSlotState } from "../domain/run-record";
import type { SqlExecutor } from "./sql-executor";
import { selectV2RunStatus, selectV2StageStatus, selectV2UnitStatus } from "../operators/select-status";
import type { EpicWorkflowProfile } from "../domain/epic";
import { PR_SUMMARY_ARTIFACT_TYPE } from "../domain/dev-flow-artifacts";
import { selectHandoffStatusFromWait, type HandoffWaitKind, type Wait, type WaitOutcome } from "../domain/wait";
import type { RunState, UnitState } from "../domain/run-record";
import { compileWorkflowDefinition } from "../compiler/compile-workflow";
import { parseWorkflowDefinition } from "../validation/workflow-definition";
import { stageInstanceIdFor } from "../decision/ids";
import type { StageKey } from "../domain/workflow";

interface GateProjectionRow {
  readonly run_id: string;
  readonly stage_name: string;
  readonly stage_instance_id: string;
  readonly unit_id: string;
  readonly artifact_revision_id: string;
  readonly gate_step: string;
  readonly actions: readonly string[];
}

interface V2GateProjectionRow extends GateProjectionRow {
  readonly wait_id: string;
  readonly repository_key: string | null;
  readonly run_state: RunState;
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
  /** The v2 run-record projection — null when the run itself does not exist; a v2-empty run (nothing materialized under it yet) is an empty `units` array, not null. */
  get_run_record_detail(run_id: WorkflowRunId): Promise<OperatorRunRecordDetail | null>;
}

interface V2RunProjectionRow { readonly id: string; readonly workflow_name: string; readonly root_workflow_id: string; readonly state: RunState; readonly current_stage: string | null; readonly parked_count: string; readonly updated_at: string; readonly is_stuck: boolean; readonly archived: boolean; readonly has_materialized_stage: boolean }
interface OperatorExecutorReference { readonly kind?: string; readonly session_id?: string; readonly worktree_base_sha?: string }
interface V2StageProjectionRow { readonly stage_instance_id: string; readonly name: string; readonly stage_type: string; readonly operator_role: string | null; readonly state: RunState; readonly has_open_wait: boolean }
interface V2UnitProjectionRow { readonly stage_instance_id: string; readonly unit_id: string; readonly params: OperatorStageUnit["params"]; readonly state: UnitState; readonly external_reference: OperatorExecutorReference | null; readonly gate_step: string | null; readonly has_open_wait: boolean; readonly admission_required: boolean; readonly admitted: boolean; readonly admission_blocked_by: readonly string[] }
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
interface V2CohortProjectionRow extends Omit<CohortProjectionRow, "dbos_status" | "updated_at_epoch_ms"> { readonly unit_state: UnitState; readonly updated_at: string }

export class PostgresOperatorProjectionRepository implements OperatorProjectionRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async list_pending_gates(run_id?: WorkflowRunId): Promise<readonly OperatorParkedGate[]> {
    return this.listV2PendingGates(run_id);
  }

  private async listV2PendingGates(run_id?: WorkflowRunId): Promise<readonly OperatorParkedGate[]> {
    // No `run.state='active'` filter — spec §1 rule 9 / §3.7: an open wait is
    // listed whatever the run's state, and `actionable` (derived below from
    // `run_state`) says whether a decision on it can still take effect. A
    // collection-member gate (brief_writer: one unit `"0"` fanning artifacts
    // out per cohort) reports its `collection_key` as `unit_id` instead of the
    // owning unit's own id, so an operator can tell cohort gates apart.
    const rows = await this.sql.query<V2GateProjectionRow>(
      `SELECT wait.id::text AS wait_id,stage.run_id::text,stage.stage_key AS stage_name,wait.stage_instance_id::text,
              COALESCE(wait.collection_key,wait.unit_id) AS unit_id,wait.artifact_revision_id::text,wait.closes_on->>'gate_step' AS gate_step,
              COALESCE(ARRAY(SELECT jsonb_array_elements_text(wait.closes_on->'actions')),ARRAY[]::text[]) AS actions,
              COALESCE(unit.parameters->'artifact'->>'repository_key',unit.parameters->>'repository_key') AS repository_key,
              run.state AS run_state
       FROM oakridge.wait wait
       JOIN oakridge.run_unit unit ON unit.id=wait.run_unit_id
       JOIN oakridge.stage_instance stage ON stage.id=unit.stage_instance_id
       JOIN oakridge.workflow_run run ON run.id=unit.run_id
       JOIN oakridge.artifact artifact ON artifact.id=wait.artifact_revision_id
       WHERE wait.kind='gate' AND wait.status='open' AND run.archived=false
         AND artifact.lifecycle_state='current' AND ($1::uuid IS NULL OR run.id=$1::uuid)
       ORDER BY wait.opened_at,wait.id`, [run_id ?? null]);
    return rows.map((row) => ({ id: row.wait_id, stage_instance_id: row.stage_instance_id as import("../domain/primitives").StageInstanceId, gate_type: row.gate_step, run_id: row.run_id as WorkflowRunId,
      stage_name: row.stage_name, unit_id: row.unit_id as UnitId, repository_key: row.repository_key,
      artifact_revision_id: row.artifact_revision_id as ArtifactId, gate_step: row.gate_step, worktree: null,
      resume_actions: row.actions, pr_url: null, run_state: row.run_state, actionable: selectGateActionability(row.run_state) }));
  }

  async list_runs(filter: "active" | "archived" | "all" = "active"): Promise<readonly OperatorRunSummary[]> {
    return this.listV2RunSummaries(filter, null);
  }

  private async listV2RunSummaries(filter: "active" | "archived" | "all", run_id: WorkflowRunId | null): Promise<readonly OperatorRunSummary[]> {
    const rows = await this.sql.query<V2RunProjectionRow>(
      `SELECT run.id::text,definition.name AS workflow_name,launch.root_workflow_id,run.state,
              current_stage.stage_key AS current_stage,COALESCE(waits.parked_count,0)::text AS parked_count,
              GREATEST(run.created_at,COALESCE(run.ended_at,run.created_at),COALESCE(progress.updated_at,run.created_at))::text AS updated_at,
              EXISTS (SELECT 1 FROM oakridge.stage_instance stage WHERE stage.run_id=run.id AND stage.attempt_root_workflow_id IS NULL) AS has_materialized_stage,
              run.state='active'
                AND EXISTS (SELECT 1 FROM oakridge.run_unit unit WHERE unit.run_id=run.id AND unit.state NOT IN ('satisfied','failed','cancelled'))
                AND NOT EXISTS (SELECT 1 FROM oakridge.wait wait JOIN oakridge.run_unit unit ON unit.id=wait.run_unit_id WHERE unit.run_id=run.id AND wait.status='open')
                AND NOT EXISTS (SELECT 1 FROM oakridge.work_order work JOIN oakridge.run_unit unit ON unit.id=work.run_unit_id WHERE unit.run_id=run.id AND work.state IN ('available','started'))
                AND NOT EXISTS (SELECT 1 FROM oakridge.run_unit unit WHERE unit.run_id=run.id AND unit.admitted=false) AS is_stuck,
              run.archived
       FROM oakridge.workflow_run run
       JOIN oakridge.workflow_definition definition ON definition.id=run.workflow_definition_id
       LEFT JOIN LATERAL (SELECT attempt.root_workflow_id FROM oakridge.workflow_attempt attempt WHERE attempt.run_id=run.id ORDER BY attempt.created_at DESC LIMIT 1) launch ON true
       LEFT JOIN LATERAL (SELECT stage.stage_key FROM oakridge.stage_instance stage WHERE stage.run_id=run.id AND stage.attempt_root_workflow_id IS NULL AND stage.state='active' ORDER BY stage.started_at DESC LIMIT 1) current_stage ON true
       LEFT JOIN LATERAL (SELECT count(*) AS parked_count FROM oakridge.wait wait JOIN oakridge.run_unit unit ON unit.id=wait.run_unit_id WHERE unit.run_id=run.id AND wait.status='open') waits ON true
       LEFT JOIN LATERAL (SELECT max(transition.created_at) AS updated_at FROM oakridge.run_transition transition WHERE transition.run_id=run.id) progress ON true
       WHERE ($1::boolean IS NULL OR run.archived=$1::boolean) AND ($2::uuid IS NULL OR run.id=$2::uuid)
       ORDER BY updated_at DESC`, [filter === "all" ? null : filter === "archived", run_id]);
    return rows.map((row) => {
      const parked_count = Number(row.parked_count);
      const status = selectV2RunStatus({ state: row.state, parked_count, has_materialized_stage: row.has_materialized_stage });
      return { id: row.id as WorkflowRunId, workflow_name: row.workflow_name,
        current_attempt_root_workflow_id: row.root_workflow_id, status, current_stage: row.current_stage,
        parked_count, updated_at: row.updated_at, is_stuck: row.is_stuck, is_failed: status === "failed", archived: row.archived };
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

  async get_run_record_detail(run_id: WorkflowRunId): Promise<OperatorRunRecordDetail | null> {
    const runRows = await this.sql.query<{ readonly state: string; readonly record_version: string }>(
      "SELECT state, record_version::text FROM oakridge.workflow_run WHERE id = $1", [run_id]);
    const run = runRows[0];
    if (!run) return null;

    const unitRows = await this.sql.query<{ readonly id: string; readonly unit_id: string; readonly state: OperatorRunRecordUnitFacts["unit_state"]; readonly admitted: boolean }>(
      "SELECT id::text, unit_id, state, admitted FROM oakridge.run_unit WHERE run_id = $1 ORDER BY unit_id", [run_id]);
    const runUnitIds = unitRows.map((row) => row.id);

    // One query per related table for the whole run, not per unit — a run
    // with many units would otherwise pay 3 queries each for slots, waits,
    // and work orders.
    const groupByRunUnit = <Row extends { readonly run_unit_id: string }>(rows: readonly Row[]): Map<string, Row[]> => {
      const grouped = new Map<string, Row[]>();
      for (const row of rows) {
        const existing = grouped.get(row.run_unit_id);
        if (existing) existing.push(row); else grouped.set(row.run_unit_id, [row]);
      }
      return grouped;
    };

    const slotRows = await this.sql.query<{ readonly run_unit_id: string; readonly output_name: string; readonly collection_key: string | null; readonly artifact_type: string; readonly required: boolean; readonly state: RunOutputSlotState["kind"]; readonly artifact_revision_id: string | null; readonly version: string }>(
      "SELECT run_unit_id::text, output_name, collection_key, artifact_type, required, state, artifact_revision_id::text, version::text FROM oakridge.run_output_slot WHERE run_unit_id = ANY($1::uuid[]) ORDER BY output_name,collection_key NULLS FIRST", [runUnitIds]);
    const slotsByUnit = groupByRunUnit(slotRows);

    const waitRows = await this.sql.query<{ readonly id: string; readonly run_unit_id: string; readonly output_name: string | null; readonly collection_key: string | null; readonly kind: OperatorRunRecordWait["kind"]; readonly status: OperatorRunRecordWait["status"]; readonly opened_at: string }>(
      "SELECT id::text, run_unit_id::text, output_name, collection_key, kind, status, opened_at::text FROM oakridge.wait WHERE run_unit_id = ANY($1::uuid[]) ORDER BY opened_at", [runUnitIds]);
    const waitsByUnit = groupByRunUnit(waitRows);

    const orderRows = await this.sql.query<{ readonly id: string; readonly run_unit_id: string; readonly reason: string; readonly state: OperatorRunRecordWorkOrder["state"]; readonly workflow_id: string; readonly health: OperatorRunRecordWorkOrder["executor_health"]; readonly cleanup_state: string | null; readonly dbos_status: string | null }>(
      `SELECT work.id::text, work.run_unit_id::text, work.reason, work.state, work.workflow_id, attachment.health, attachment.cleanup_state,
              status.status AS dbos_status
       FROM oakridge.work_order work
       LEFT JOIN oakridge.executor_attachment attachment ON attachment.work_order_id = work.id
       LEFT JOIN dbos.workflow_status status ON status.workflow_uuid = work.workflow_id
       WHERE work.run_unit_id = ANY($1::uuid[]) ORDER BY work.created_at`, [runUnitIds]);
    const ordersByUnit = groupByRunUnit(orderRows);
    const dependencyRows = await this.sql.query<{ readonly run_unit_id: string; readonly dependency_id: string; readonly dependency_unit_id: string; readonly dependency_state: string; readonly has_missing_slot: boolean }>(`SELECT unit.id::text AS run_unit_id,dependency.id::text AS dependency_id,dependency.unit_id AS dependency_unit_id,dependency.state AS dependency_state,
      EXISTS (SELECT 1 FROM oakridge.run_output_slot slot WHERE slot.run_unit_id=dependency.id AND slot.required AND slot.state <> 'released') AS has_missing_slot
      FROM oakridge.run_unit_dependency edge JOIN oakridge.run_unit unit ON unit.stage_instance_id=edge.stage_instance_id AND unit.unit_id=edge.unit_id
      JOIN oakridge.run_unit dependency ON dependency.stage_instance_id=edge.stage_instance_id AND dependency.unit_id=edge.depends_on_unit_id
      WHERE unit.id=ANY($1::uuid[]) ORDER BY dependency.unit_id`, [runUnitIds]);
    const dependenciesByUnit = groupByRunUnit(dependencyRows);

    const units: OperatorRunRecordUnit[] = unitRows.map((unitRow) => {
      const runUnitId = unitRow.id as RunUnitId;
      const slots: OperatorRunRecordSlot[] = (slotsByUnit.get(unitRow.id) ?? []).map((slot) => ({
        output_name: slot.output_name, collection_key: slot.collection_key, artifact_type: slot.artifact_type, required: slot.required, state: slot.state,
        artifact_revision_id: slot.artifact_revision_id as ArtifactId | null, version: Number(slot.version),
      }));
      const waits: readonly OperatorRunRecordWait[] = waitsByUnit.get(unitRow.id) ?? [];
      const work_orders: OperatorRunRecordWorkOrder[] = (ordersByUnit.get(unitRow.id) ?? []).map((order) => ({
        id: order.id as WorkOrderId, reason: order.reason, state: order.state, workflow_id: order.workflow_id,
        executor_health: order.health, cleanup_state: order.cleanup_state, dbos_liveness: order.dbos_status,
      }));
      const blocked_by = (dependenciesByUnit.get(unitRow.id) ?? []).filter((dependency) => dependency.dependency_state !== "satisfied" || dependency.has_missing_slot).map((dependency) => dependency.dependency_unit_id as UnitId);

      const decision = selectRunRecordUnitDecision({
        unit_state: unitRow.state,
        all_required_released: slots.filter((slot) => slot.required).every((slot) => slot.state === "released"),
        has_open_wait: waits.some((wait) => wait.status === "open"),
        has_available_work_order: work_orders.some((order) => order.state === "available"),
        has_started_work_order: work_orders.some((order) => order.state === "started"),
        is_admitted: unitRow.admitted,
        dependencies_satisfied: blocked_by.length === 0,
      });

      return { run_unit_id: runUnitId, unit_id: unitRow.unit_id as UnitId, decision, admitted: unitRow.admitted, blocked_by, slots, waits, work_orders };
    });

    const transitionRows = await this.sql.query<{ readonly operation: string; readonly output_name: string | null; readonly collection_key: string | null; readonly actor: string; readonly prior_record_version: string; readonly resulting_record_version: string; readonly created_at: string }>(
      `SELECT operation, output_name, collection_key, actor, prior_record_version::text, resulting_record_version::text, created_at::text
       FROM oakridge.run_transition WHERE run_id = $1 ORDER BY resulting_record_version DESC, created_at DESC LIMIT 20`, [run_id]);
    const recent_transitions: OperatorRunRecordTransition[] = transitionRows.map((transition) => ({
      operation: transition.operation, output_name: transition.output_name, collection_key: transition.collection_key, actor: transition.actor,
      prior_record_version: Number(transition.prior_record_version), resulting_record_version: Number(transition.resulting_record_version),
      created_at: transition.created_at,
    }));

    return { run_id, state: run.state, record_version: Number(run.record_version), units, recent_transitions };
  }

  async get_run(id: WorkflowRunId): Promise<OperatorRunDetail | null> {
    return this.getV2Run(id);
  }

  private async getV2Run(id: WorkflowRunId): Promise<OperatorRunDetail | null> {
    const summary = (await this.listV2RunSummaries("all", id))[0];
    if (!summary) return null;
    const stageRows = await this.sql.query<V2StageProjectionRow>(
      `SELECT stage.id::text AS stage_instance_id,stage.stage_key AS name,stage.stage_type,
              stage.stage_contract->>'operator_role' AS operator_role,stage.state,
              EXISTS (SELECT 1 FROM oakridge.wait wait JOIN oakridge.run_unit unit ON unit.id=wait.run_unit_id WHERE unit.stage_instance_id=stage.id AND wait.status='open') AS has_open_wait
       FROM oakridge.stage_instance stage WHERE stage.run_id=$1 AND stage.attempt_root_workflow_id IS NULL ORDER BY stage.started_at,stage.stage_key`, [id]);
    const unitRows = await this.sql.query<V2UnitProjectionRow>(
      `SELECT unit.stage_instance_id::text,unit.unit_id,unit.parameters AS params,unit.state,attachment.external_reference,
              gate.gate_step,EXISTS (SELECT 1 FROM oakridge.wait wait WHERE wait.run_unit_id=unit.id AND wait.status='open') AS has_open_wait,
              policy.manual_admission AS admission_required,unit.admitted,
              COALESCE(ARRAY(SELECT edge.depends_on_unit_id FROM oakridge.run_unit_dependency edge
                LEFT JOIN oakridge.run_unit dependency ON dependency.stage_instance_id=edge.stage_instance_id AND dependency.unit_id=edge.depends_on_unit_id
                WHERE edge.stage_instance_id=unit.stage_instance_id AND edge.unit_id=unit.unit_id AND (dependency.id IS NULL OR dependency.state<>'satisfied') ORDER BY edge.depends_on_unit_id),ARRAY[]::text[]) AS admission_blocked_by
       FROM oakridge.run_unit unit
       JOIN oakridge.run_stage_scheduling_policy policy ON policy.stage_instance_id=unit.stage_instance_id
       LEFT JOIN LATERAL (SELECT executor.external_reference FROM oakridge.work_order work JOIN oakridge.executor_attachment executor ON executor.work_order_id=work.id WHERE work.run_unit_id=unit.id ORDER BY work.created_at DESC LIMIT 1) attachment ON true
       LEFT JOIN LATERAL (SELECT wait.closes_on->>'gate_step' AS gate_step FROM oakridge.wait wait WHERE wait.run_unit_id=unit.id AND wait.kind='gate' AND wait.status='open' ORDER BY wait.opened_at LIMIT 1) gate ON true
       WHERE unit.run_id=$1 ORDER BY unit.stage_instance_id,unit.unit_id`, [id]);
    const artifactRows = await this.sql.query<StageArtifactRow>(
      `SELECT DISTINCT ON (artifact.stage_instance_id,artifact.unit_id,artifact.output_name,artifact.collection_key)
              artifact.stage_instance_id::text,artifact.id::text,artifact.artifact_type AS type_id,artifact.version,artifact.label
       FROM oakridge.artifact artifact WHERE artifact.run_id=$1 AND artifact.lifecycle_state IN ('current','released')
       ORDER BY artifact.stage_instance_id,artifact.unit_id,artifact.output_name,artifact.collection_key,artifact.version DESC`, [id]);
    const stages: OperatorStageDetail[] = stageRows.map((stage) => {
      const units: OperatorStageUnit[] = unitRows.filter((unit) => unit.stage_instance_id === stage.stage_instance_id).map((unit) => ({
        unit_id: unit.unit_id as UnitId, repository_key: null, params: unit.params,
        sid: unit.external_reference?.kind === "kbbl_session" ? unit.external_reference.session_id ?? null : null,
        worktree: null, base_sha: unit.external_reference?.worktree_base_sha ?? null,
        status: selectV2UnitStatus(unit.state, unit.has_open_wait), gate: unit.gate_step,
        admission_required: unit.admission_required, admitted: unit.admitted,
        admission_eligible: unit.admission_blocked_by.length === 0, admission_blocked_by: unit.admission_blocked_by,
      }));
      const artifacts = artifactRows.filter((artifact) => artifact.stage_instance_id === stage.stage_instance_id)
        .map((artifact): OperatorStageArtifact => ({ id: artifact.id as ArtifactId, type_id: artifact.type_id, version: artifact.version, label: artifact.label }));
      return { stage_instance_id: stage.stage_instance_id as import("../domain/primitives").StageInstanceId,
        name: stage.name, type: stage.stage_type, operator_role: stage.operator_role,
        status: selectV2StageStatus(stage.state, stage.has_open_wait), artifacts,
        delegated_kbbl_sid: units.find((unit) => unit.sid)?.sid ?? null, worktree: null, units };
    });
    const profileRows = await this.sql.query<EpicProfileRow>(`SELECT id::text,workflow_run_id::text,title,slug,lifecycle_state,final_merge_policy,
      base_branch,repositories,created_at::text,updated_at::text FROM oakridge.epic_workflow_profile WHERE workflow_run_id=$1`, [id]);
    const profile = profileRows[0];
    const epic_profile: EpicWorkflowProfile | null = profile ? { ...profile, id: profile.id as EpicWorkflowProfile["id"], workflow_run_id: profile.workflow_run_id as WorkflowRunId } : null;
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
      const parsedDefinition = parseWorkflowDefinition(definitionJson);
      if (!parsedDefinition.ok) throw new Error(`run ${id}'s stored workflow definition is invalid: ${parsedDefinition.error.detail}`);
      const compiled = compileWorkflowDefinition(parsedDefinition.value);
      if (!compiled.ok) throw new Error(`run ${id}'s stored workflow definition does not compile: ${compiled.error.detail}`);
      const storedStageKeys = stageRows.map((stage) => stage.name as StageKey);
      for (const stage_key of selectPendingStageOrder(compiled.value, storedStageKeys)) {
        const contract = compiled.value.stages[stage_key];
        if (!contract) continue; // selectPendingStageOrder only yields definition stage keys; defensive only.
        pendingStages.push({ stage_instance_id: stageInstanceIdFor(id, stage_key), name: stage_key, type: contract.stage_type,
          operator_role: contract.operator_role, status: "pending", artifacts: [], delegated_kbbl_sid: null, worktree: null, units: [] });
      }
    }
    return { id: summary.id, workflow_name: summary.workflow_name, current_attempt_root_workflow_id: summary.current_attempt_root_workflow_id,
      attempts: [], status: summary.status, stages: [...stages, ...pendingStages], parked_count: summary.parked_count, updated_at: summary.updated_at,
      is_stuck: summary.is_stuck, epic_profile, run_record: await this.get_run_record_detail(id) };
  }

  async get_review_inbox(): Promise<OperatorReviewInbox> {
    const [allGates, runs, projectedCohorts] = await Promise.all([this.list_pending_gates(), this.list_runs(), this.list_cohorts()]);
    // The inbox is the operator's decision queue. A gate stranded by a run
    // that has ended is still listed by `list_pending_gates` (spec §3.7) and
    // rendered on the run, but no decision on it can take effect, so it is
    // not queued here as work.
    const gates = allGates.filter((gate) => gate.actionable);
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
        workflow_name: names.get(gate.run_id) ?? "unknown", stage_instance_id: gate.stage_instance_id ?? gate.id.slice(0, gate.id.indexOf(":")) as import("../domain/primitives").StageInstanceId,
        stage_name: gate.stage_name, unit_id: gate.unit_id, repository_key: cohort?.repository_key ?? gate.repository_key, title: cohort?.title ?? null,
        lifecycle: isMerge ? "merge_confirmation" : "artifact_review", artifact_revision_id: gate.artifact_revision_id,
        artifact_url: gate.artifact_revision_id ? `/artifact_details/${gate.artifact_revision_id}` : null,
        gate_id: gate.id, gate_url: `/oakridge/gates/${gate.id}`, resume_actions: gate.resume_actions, blocked_by: [], pr_url: gate.pr_url, completed_at: null,
      };
    });
    for (const cohort of cohorts) {
      if (cohort.lifecycle === "waiting_admission") {
        items.push({ id: `${cohort.id}:admission`, kind: "admission", state: cohort.admission.eligible ? "actionable" : "blocked",
          run_id: cohort.run_id, workflow_name: cohort.workflow_name, stage_instance_id: cohort.stage_instance_id,
          stage_name: cohort.stage_name, unit_id: cohort.unit_id, repository_key: cohort.repository_key, title: cohort.title,
          lifecycle: cohort.lifecycle, artifact_revision_id: null, artifact_url: null, gate_id: null, gate_url: null,
          resume_actions: cohort.admission.eligible ? ["admit"] : [], blocked_by: cohort.admission.blocked_by, pr_url: cohort.pr_url, completed_at: null });
      }
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
    return this.listV2Cohorts();
  }

  private async listV2Cohorts(): Promise<readonly OperatorCohortSummary[]> {
    const rows = await this.sql.query<V2CohortProjectionRow>(`SELECT stage.run_id::text,definition.name AS workflow_name,stage.id::text AS stage_instance_id,
      stage.stage_key AS stage_name,unit.unit_id,unit.parameters AS params,unit.state AS unit_state,artifact.id::text AS artifact_revision_id,
      policy.manual_admission AS admission_required,unit.admitted,
      NOT EXISTS (SELECT 1 FROM oakridge.run_unit_dependency edge LEFT JOIN oakridge.run_unit dependency ON dependency.stage_instance_id=edge.stage_instance_id AND dependency.unit_id=edge.depends_on_unit_id WHERE edge.stage_instance_id=unit.stage_instance_id AND edge.unit_id=unit.unit_id AND (dependency.id IS NULL OR dependency.state<>'satisfied')) AS admission_eligible,
      COALESCE(ARRAY(SELECT edge.depends_on_unit_id FROM oakridge.run_unit_dependency edge LEFT JOIN oakridge.run_unit dependency ON dependency.stage_instance_id=edge.stage_instance_id AND dependency.unit_id=edge.depends_on_unit_id WHERE edge.stage_instance_id=unit.stage_instance_id AND edge.unit_id=unit.unit_id AND (dependency.id IS NULL OR dependency.state<>'satisfied')),ARRAY[]::text[]) AS admission_blocked_by,
      handoff.kind AS handoff_wait_kind,handoff.status AS handoff_wait_status,handoff.outcome_kind AS handoff_outcome_kind,
      summary.pr_url AS summary_pr_url,CASE WHEN reconciliation.stage_instance_id IS NULL THEN NULL ELSE jsonb_build_object('repository_key',reconciliation.repository_key,'observation',reconciliation.observation,'mismatch',reconciliation.mismatch,'completed_at',reconciliation.completed_at,'updated_at',reconciliation.updated_at) END AS reconciliation,
      GREATEST(unit.created_at,COALESCE(unit.ended_at,unit.created_at),COALESCE(artifact.created_at,unit.created_at))::text AS updated_at
      FROM oakridge.run_unit unit JOIN oakridge.stage_instance stage ON stage.id=unit.stage_instance_id
      JOIN oakridge.workflow_run run ON run.id=unit.run_id JOIN oakridge.workflow_definition definition ON definition.id=run.workflow_definition_id
      JOIN oakridge.run_stage_scheduling_policy policy ON policy.stage_instance_id=stage.id
      CROSS JOIN LATERAL (SELECT output.value->>'name' AS output_name FROM jsonb_array_elements(stage.stage_contract->'outputs') output(value) WHERE output.value->'release'->>'kind'='handoff' ORDER BY output.value->>'name' LIMIT 1) handoff_output
      LEFT JOIN LATERAL (SELECT candidate.* FROM oakridge.artifact candidate WHERE candidate.stage_instance_id=stage.id AND candidate.unit_id=unit.unit_id AND candidate.output_name=handoff_output.output_name AND candidate.lifecycle_state IN ('current','released') ORDER BY candidate.version DESC,candidate.id LIMIT 1) artifact ON true
      LEFT JOIN LATERAL (SELECT wait.kind,wait.status,wait.outcome->>'kind' AS outcome_kind FROM oakridge.wait wait WHERE wait.artifact_revision_id=artifact.id AND wait.kind IN ('handoff_downstream','handoff_external') ORDER BY (wait.kind='handoff_external') DESC LIMIT 1) handoff ON true
      LEFT JOIN LATERAL (SELECT candidate.body->>'pr_url' AS pr_url FROM oakridge.artifact candidate WHERE candidate.stage_instance_id=stage.id AND candidate.unit_id=unit.unit_id AND candidate.artifact_type='${PR_SUMMARY_ARTIFACT_TYPE}' AND candidate.lifecycle_state IN ('current','released') ORDER BY candidate.version DESC,candidate.id LIMIT 1) summary ON true
      LEFT JOIN oakridge.cohort_pull_request_reconciliation reconciliation ON reconciliation.stage_instance_id=stage.id AND reconciliation.unit_id=unit.unit_id
      WHERE run.archived=false AND stage.attempt_root_workflow_id IS NULL ORDER BY updated_at DESC`, []);
    return rows.map((row) => {
      const handoffStatus = row.handoff_outcome_kind === "cancelled" ? null : row.handoff_wait_kind && row.handoff_wait_status ? selectHandoffStatusFromWait(row.handoff_wait_kind, row.handoff_wait_status, row.handoff_outcome_kind) : null;
      const lifecycle: OperatorCohortLifecycle = row.unit_state === "failed" || row.unit_state === "cancelled" ? "failed" : row.reconciliation?.mismatch ? "pull_request_mismatch" : handoffStatus === "released" ? "complete" : handoffStatus === "awaiting_external" ? "github_review" : handoffStatus === "revision_requested" ? "revision_requested" : handoffStatus === "awaiting_downstream" ? "assessing" : row.admission_required && !row.admitted ? "waiting_admission" : "building";
      const artifact = row.artifact_revision_id as ArtifactId | null; const cohort = row.params?.artifact ?? null;
      return { id: `${row.stage_instance_id}:${row.unit_id}`,run_id: row.run_id as WorkflowRunId,workflow_name: row.workflow_name,stage_instance_id: row.stage_instance_id as import("../domain/primitives").StageInstanceId,stage_name: row.stage_name,unit_id: row.unit_id as UnitId,repository_key: cohort?.repository_key ?? null,title: cohort?.title ?? null,lifecycle,completion: { build_complete: artifact !== null, assessment_complete: lifecycle === "complete" },admission: { required: row.admission_required, admitted: row.admitted, eligible: row.admission_eligible, blocked_by: row.admission_blocked_by },artifact_revision_id: artifact,artifact_url: artifact ? `/artifact_details/${artifact}` : null,gate_id: null,gate_url: null,pr_url: row.reconciliation?.observation.url ?? row.summary_pr_url ?? null,pull_request_reconciliation: row.reconciliation,updated_at: row.updated_at };
    });
  }
}
