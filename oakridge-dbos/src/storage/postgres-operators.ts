import type { ArtifactId, ExecutionId, RunUnitId, StageInstanceId, UnitId, WorkflowRunId, WorkOrderId } from "../domain/primitives";
import { selectGateActionability, selectPendingStageOrder, selectRunRecordUnitDecision, type OperatorApplicationVersionInventory, type OperatorCohortSummary, type OperatorParkedGate, type OperatorReviewInbox, type OperatorReviewInboxItem, type OperatorRunDetail, type OperatorRunDiagnosis, type OperatorRunDiagnosisSession, type OperatorRunRecordDetail, type OperatorRunRecordSlot, type OperatorRunRecordTransition, type OperatorRunRecordUnit, type OperatorRunRecordUnitFacts, type OperatorRunRecordWait, type OperatorRunRecordWorkOrder, type OperatorRunSessionAttempt, type OperatorRunSummary, type OperatorSessionRunLocation, type OperatorStageArtifact, type OperatorStageDetail, type OperatorStageUnit } from "../domain/operator-projections";
import type { RunOutputSlotState } from "../domain/run-record";
import type { SessionLaunchReasonName } from "../domain/delegated-session";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";
import type { BlockedReason, CoreStatus, NextActor } from "../domain/records";
import { compileWorkflowDefinition } from "../compiler/compile-workflow";
import { parseWorkflowDefinition, type AdapterRoleRegistry } from "../validation/workflow-definition";
import { stageInstanceIdFor } from "../decision/ids";
import type { StageKey } from "../domain/workflow";
import { selectSessionHoldClaim, type SessionHold } from "../domain/session-hold";
import type { SessionHoldRepository, SessionRunLocationRepository } from "./repositories";
import { runRecordWorkflowId } from "../domain/workflow-ids";
import { projectRunEvent, type RunEvent, type RunEventRow } from "../domain/run-event";
import type { CohortId } from "../domain/primitives";
import type { DevFlowBuildCohort } from "../domain/cohort-pull-request";
import type { PullRequest, PullRequestId, PullRequestMergeClosure, PullRequestMergeClosureId, PullRequestObservation, PullRequestObservationId, PullRequestVerificationId, StoredPullRequestObservation } from "../domain/pull-request";
import { err, ok, type Result } from "../domain/primitives";
import type { CurrentVerifiedCohortPullRequest, DevFlowPullRequestRepository } from "./repositories";

interface GateProjectionRow {
  readonly run_id: string;
  readonly stage_name: string;
  readonly stage_instance_id: string;
  readonly unit_id: string;
  readonly artifact_revision_id: string | null;
  readonly gate_step: string;
  readonly actions: readonly string[];
}

interface CurrentPullRequestRow {
  readonly cohort_id: string; readonly stage_instance_id: string; readonly cohort_key: string;
  readonly repository_key: string; readonly repository_path: string; readonly canonical_ref: string;
  readonly expected_pr_base: string; readonly recorded_head_sha: string; readonly verification_id: string;
  readonly cohort_created_at: string; readonly cohort_updated_at: string;
  readonly pull_request_id: string; readonly provider: "github"; readonly owner: string; readonly name: string;
  readonly forge_pull_request_id: string; readonly url: string; readonly pull_request_created_at: string;
  readonly observation_id: string; readonly head_ref: string; readonly base_ref: string; readonly head_sha: string | null;
  readonly state: PullRequestObservation["state"]; readonly source: PullRequestObservation["source"];
  readonly observed_at: string; readonly merged_at: string | null; readonly recorded_at: string;
}

interface BuildCohortRow {
  readonly cohort_id: string; readonly stage_instance_id: string; readonly cohort_key: string;
  readonly repository_key: string; readonly repository_path: string; readonly canonical_ref: string;
  readonly expected_pr_base: string; readonly recorded_head_sha: string;
  readonly current_verified_pull_request_id: string | null; readonly created_at: string; readonly updated_at: string;
}

const buildCohortFromRow = (row: BuildCohortRow): DevFlowBuildCohort => ({
  ...row,
  cohort_id: row.cohort_id as CohortId,
  stage_instance_id: row.stage_instance_id as StageInstanceId,
  current_verified_pull_request_id: row.current_verified_pull_request_id as PullRequestVerificationId | null,
});

const BUILD_COHORT_COLUMNS = `cohort_id::text,stage_instance_id::text,cohort_key,repository_key,repository_path,
  canonical_ref,expected_pr_base,recorded_head_sha,current_verified_pull_request_id::text,created_at::text,updated_at::text`;

/** PostgreSQL implementation of the shared cohort/final-stage PR entity. */
export class PostgresDevFlowPullRequestRepository implements DevFlowPullRequestRepository {
  constructor(private readonly sql: TransactionalSqlExecutor) {}

  async create_cohort(cohort: DevFlowBuildCohort): Promise<DevFlowBuildCohort> {
    return this.sql.transaction(async (tx) => {
      await tx.query(`INSERT INTO oakridge.dev_flow_build_cohort
        (cohort_id,stage_instance_id,cohort_key,repository_key,repository_path,canonical_ref,expected_pr_base,recorded_head_sha,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (cohort_id) DO NOTHING`,
      [cohort.cohort_id, cohort.stage_instance_id, cohort.cohort_key, cohort.repository_key, cohort.repository_path,
        cohort.canonical_ref, cohort.expected_pr_base, cohort.recorded_head_sha, cohort.created_at, cohort.updated_at]);
      const rows = await tx.query<BuildCohortRow>(`SELECT ${BUILD_COHORT_COLUMNS}
        FROM oakridge.dev_flow_build_cohort WHERE cohort_id=$1`, [cohort.cohort_id]);
      const stored = rows[0];
      if (!stored) throw new Error(`build cohort '${cohort.cohort_id}' was not stored`);
      const result = buildCohortFromRow(stored);
      const immutableMatches = result.stage_instance_id === cohort.stage_instance_id && result.cohort_key === cohort.cohort_key
        && result.repository_key === cohort.repository_key && result.repository_path === cohort.repository_path
        && result.canonical_ref === cohort.canonical_ref && result.expected_pr_base === cohort.expected_pr_base;
      if (!immutableMatches) throw new Error(`build cohort '${cohort.cohort_id}' already exists with different branch roles`);
      return result;
    });
  }

  async advance_cohort_head(input: { readonly cohort_id: CohortId; readonly expected_head_sha: string; readonly next_head_sha: string; readonly advanced_at: string }): Promise<Result<DevFlowBuildCohort, { readonly kind: "cohort_not_found" | "ref_lease_mismatch"; readonly detail: string }>> {
    const rows = await this.sql.query<BuildCohortRow>(`UPDATE oakridge.dev_flow_build_cohort
      SET recorded_head_sha=$3,pending_head_sha=NULL,updated_at=$4
      WHERE cohort_id=$1 AND recorded_head_sha=$2 AND pending_head_sha=$3
      RETURNING ${BUILD_COHORT_COLUMNS}`, [input.cohort_id, input.expected_head_sha, input.next_head_sha, input.advanced_at]);
    if (rows[0]) return ok(buildCohortFromRow(rows[0]));
    const current = await this.sql.query<{ readonly recorded_head_sha: string }>(
      "SELECT recorded_head_sha FROM oakridge.dev_flow_build_cohort WHERE cohort_id=$1", [input.cohort_id]);
    if (!current[0]) return err({ kind: "cohort_not_found", detail: `build cohort '${input.cohort_id}' was not found` });
    return err({ kind: "ref_lease_mismatch", detail: `stored cohort head moved from '${input.expected_head_sha}' to '${current[0].recorded_head_sha}'` });
  }

  async begin_cohort_advance(input: { readonly cohort_id: CohortId; readonly expected_head_sha: string; readonly next_head_sha: string; readonly prepared_at: string }): Promise<Result<void, { readonly kind: "cohort_not_found" | "ref_lease_mismatch"; readonly detail: string }>> {
    const rows = await this.sql.query<{ readonly cohort_id: string }>(`UPDATE oakridge.dev_flow_build_cohort
      SET pending_head_sha=$3,updated_at=$4
      WHERE cohort_id=$1 AND recorded_head_sha=$2 AND (pending_head_sha IS NULL OR pending_head_sha=$3)
      RETURNING cohort_id::text`, [input.cohort_id, input.expected_head_sha, input.next_head_sha, input.prepared_at]);
    if (rows[0]) return ok(undefined);
    const current = await this.sql.query<{ readonly recorded_head_sha: string }>(
      "SELECT recorded_head_sha FROM oakridge.dev_flow_build_cohort WHERE cohort_id=$1", [input.cohort_id]);
    if (!current[0]) return err({ kind: "cohort_not_found", detail: `build cohort '${input.cohort_id}' was not found` });
    return err({ kind: "ref_lease_mismatch", detail: "another cohort ref advance is already pending or the stored head changed" });
  }

  async find_cohort_for_unit(stage_instance_id: StageInstanceId, unit_id: UnitId): Promise<DevFlowBuildCohort | null> {
    const rows = await this.sql.query<BuildCohortRow>(`SELECT ${BUILD_COHORT_COLUMNS}
      FROM oakridge.dev_flow_build_cohort WHERE stage_instance_id=$1 AND cohort_key=$2`, [stage_instance_id, unit_id]);
    const row = rows[0];
    return row ? buildCohortFromRow(row) : null;
  }

  async find_current_for_unit(stage_instance_id: StageInstanceId, unit_id: UnitId): Promise<CurrentVerifiedCohortPullRequest | null> {
    const rows = await this.sql.query<CurrentPullRequestRow>(`SELECT
      cohort.cohort_id::text,cohort.stage_instance_id::text,cohort.cohort_key,cohort.repository_key,cohort.repository_path,
      cohort.canonical_ref,cohort.expected_pr_base,cohort.recorded_head_sha,cohort.current_verified_pull_request_id::text AS verification_id,
      cohort.created_at::text AS cohort_created_at,cohort.updated_at::text AS cohort_updated_at,
      pull_request.id::text AS pull_request_id,pull_request.provider,pull_request.owner,pull_request.name,
      pull_request.forge_pull_request_id::text,pull_request.url,pull_request.created_at::text AS pull_request_created_at,
      observation.id::text AS observation_id,observation.head_ref,observation.base_ref,observation.head_sha,
      observation.state,observation.source,observation.observed_at::text,observation.merged_at::text,observation.recorded_at::text
      FROM oakridge.dev_flow_build_cohort cohort
      JOIN oakridge.pull_request_verification verification
        ON verification.id=cohort.current_verified_pull_request_id AND verification.invalidated_at IS NULL
      JOIN oakridge.pull_request pull_request ON pull_request.id=verification.pull_request_id
      JOIN LATERAL (SELECT latest.* FROM oakridge.pull_request_observation latest
        WHERE latest.pull_request_id=verification.pull_request_id AND latest.head_sha=verification.verified_head_sha
        ORDER BY latest.observed_at DESC,latest.recorded_at DESC,latest.id DESC LIMIT 1) observation ON true
      WHERE cohort.stage_instance_id=$1 AND cohort.cohort_key=$2`, [stage_instance_id, unit_id]);
    const row = rows[0];
    if (!row) return null;
    const cohort: DevFlowBuildCohort = {
      cohort_id: row.cohort_id as CohortId, stage_instance_id: row.stage_instance_id as StageInstanceId,
      cohort_key: row.cohort_key, repository_key: row.repository_key, repository_path: row.repository_path,
      canonical_ref: row.canonical_ref, expected_pr_base: row.expected_pr_base, recorded_head_sha: row.recorded_head_sha,
      current_verified_pull_request_id: row.verification_id as PullRequestVerificationId,
      created_at: row.cohort_created_at, updated_at: row.cohort_updated_at,
    };
    const pull_request: PullRequest = {
      id: row.pull_request_id as PullRequestId, provider: row.provider,
      owner: row.owner, name: row.name, forge_pull_request_id: Number(row.forge_pull_request_id), url: row.url,
      created_at: row.pull_request_created_at,
    };
    const observation: StoredPullRequestObservation = {
      id: row.observation_id as PullRequestObservationId, pull_request_id: pull_request.id, provider: row.provider,
      owner: row.owner, name: row.name, number: Number(row.forge_pull_request_id), url: row.url,
      head_branch: row.head_ref, base_branch: row.base_ref, head_sha: row.head_sha,
      state: row.state, source: row.source, observed_at: row.observed_at, merged_at: row.merged_at, recorded_at: row.recorded_at,
    };
    return { cohort, pull_request, observation };
  }

  async observe(input: { readonly observation: PullRequestObservation; readonly recorded_at: string }): Promise<{ readonly pull_request_id: PullRequestId; readonly observation_id: PullRequestObservationId }> {
    return this.sql.transaction(async (tx) => {
      const pullRequests = await tx.query<{ readonly id: string }>(`INSERT INTO oakridge.pull_request
        (id,provider,owner,name,forge_pull_request_id,url,created_at)
        VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6)
        ON CONFLICT (provider,lower(owner),lower(name),forge_pull_request_id) DO UPDATE SET url=EXCLUDED.url
        RETURNING id::text`, [input.observation.provider, input.observation.owner,
        input.observation.name, input.observation.number, input.observation.url, input.recorded_at]);
      const pullRequestId = pullRequests[0]!.id as PullRequestId;
      const observations = await tx.query<{ readonly id: string }>(`INSERT INTO oakridge.pull_request_observation
        (id,pull_request_id,head_ref,base_ref,head_sha,state,source,observed_at,merged_at,recorded_at)
        VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text`,
      [pullRequestId, input.observation.head_branch, input.observation.base_branch, input.observation.head_sha,
        input.observation.state, input.observation.source, input.observation.observed_at, input.observation.merged_at, input.recorded_at]);
      return { pull_request_id: pullRequestId, observation_id: observations[0]!.id as PullRequestObservationId };
    });
  }

  async bind_verified(input: { readonly cohort_id: CohortId; readonly pull_request_id: PullRequestId; readonly observation_id: PullRequestObservationId; readonly verified_head_sha: string; readonly verified_at: string; readonly replace_verification_id: PullRequestVerificationId | null }): Promise<Result<PullRequestVerificationId, { readonly kind: "replacement_required" | "replacement_conflict"; readonly detail: string }>> {
    return this.sql.transaction(async (tx) => {
      const rows = await tx.query<{ readonly current_verified_pull_request_id: string | null }>(
        "SELECT current_verified_pull_request_id::text FROM oakridge.dev_flow_build_cohort WHERE cohort_id=$1 FOR UPDATE", [input.cohort_id]);
      const current = rows[0]?.current_verified_pull_request_id ?? null;
      if (current !== null && input.replace_verification_id === null) return err({ kind: "replacement_required", detail: "cohort already has a verified pull request; replacement must name it" });
      if (current !== null && current !== input.replace_verification_id) return err({ kind: "replacement_conflict", detail: "current verified pull request changed before replacement" });
      if (current !== null) {
        await tx.query("UPDATE oakridge.pull_request_verification SET invalidated_at=$2,invalidation_reason='replaced' WHERE id=$1 AND invalidated_at IS NULL", [current, input.verified_at]);
        await tx.query("UPDATE oakridge.pull_request_approval SET invalidated_at=$2 WHERE verification_id=$1 AND invalidated_at IS NULL", [current, input.verified_at]);
      }
      const inserted = await tx.query<{ readonly id: string }>(`INSERT INTO oakridge.pull_request_verification
        (id,cohort_id,pull_request_id,observation_id,verified_head_sha,verified_at)
        VALUES (gen_random_uuid(),$1,$2,$3,$4,$5) RETURNING id::text`,
      [input.cohort_id, input.pull_request_id, input.observation_id, input.verified_head_sha, input.verified_at]);
      const id = inserted[0]!.id as PullRequestVerificationId;
      await tx.query("UPDATE oakridge.dev_flow_build_cohort SET current_verified_pull_request_id=$2,updated_at=$3 WHERE cohort_id=$1", [input.cohort_id, id, input.verified_at]);
      return ok(id);
    });
  }

  async confirm_merge(input: { readonly cohort_id: CohortId; readonly pull_request_id: PullRequestId; readonly idempotency_key: string; readonly merged_at: string; readonly confirmed_at: string }): Promise<Result<{ readonly kind: "created" | "replayed"; readonly closure: PullRequestMergeClosure }, { readonly kind: "idempotency_conflict" | "pull_request_not_current" | "missing_merged_evidence"; readonly detail: string }>> {
    return this.sql.transaction(async (tx) => {
      const cohorts = await tx.query<{ readonly current_verified_pull_request_id: string | null }>(
        "SELECT current_verified_pull_request_id::text FROM oakridge.dev_flow_build_cohort WHERE cohort_id=$1 FOR UPDATE", [input.cohort_id]);
      if (!cohorts[0]?.current_verified_pull_request_id) return err({ kind: "pull_request_not_current", detail: "cohort has no current verified pull request" });
      const existing = await tx.query<{ readonly id: string; readonly cohort_id: string; readonly pull_request_id: string; readonly idempotency_key: string; readonly merged_at: string; readonly confirmed_at: string }>(
        "SELECT id::text,cohort_id::text,pull_request_id::text,idempotency_key,merged_at::text,confirmed_at::text FROM oakridge.pull_request_merge_closure WHERE cohort_id=$1 FOR UPDATE", [input.cohort_id]);
      const row = existing[0];
      if (row) {
        if (row.idempotency_key !== input.idempotency_key) return err({ kind: "idempotency_conflict", detail: "cohort merge was already confirmed with a different idempotency key" });
        return ok({ kind: "replayed", closure: { id: row.id as PullRequestMergeClosureId, cohort_id: row.cohort_id as CohortId,
          pull_request_id: row.pull_request_id as PullRequestId, idempotency_key: row.idempotency_key, merged_at: row.merged_at, confirmed_at: row.confirmed_at } });
      }
      const evidence = await tx.query<{ readonly pull_request_id: string; readonly merged_at: string | null }>(`SELECT
        verification.pull_request_id::text,observation.merged_at::text
        FROM oakridge.pull_request_verification verification
        JOIN LATERAL (SELECT latest.merged_at FROM oakridge.pull_request_observation latest
          WHERE latest.pull_request_id=verification.pull_request_id AND latest.head_sha=verification.verified_head_sha
          ORDER BY latest.observed_at DESC,latest.recorded_at DESC,latest.id DESC LIMIT 1) observation ON true
        WHERE verification.id=$1 AND verification.cohort_id=$2 AND verification.invalidated_at IS NULL`,
      [cohorts[0].current_verified_pull_request_id, input.cohort_id]);
      if (evidence[0]?.pull_request_id !== input.pull_request_id) {
        return err({ kind: "pull_request_not_current", detail: "pull request is no longer the cohort's current verified link" });
      }
      if (!evidence[0].merged_at) return err({ kind: "missing_merged_evidence", detail: "current verified pull request has no merged observation" });
      const mergedAt = evidence[0].merged_at;
      const inserted = await tx.query<{ readonly id: string }>(`INSERT INTO oakridge.pull_request_merge_closure
        (id,cohort_id,pull_request_id,idempotency_key,merged_at,confirmed_at)
        VALUES (gen_random_uuid(),$1,$2,$3,$4,$5) RETURNING id::text`,
      [input.cohort_id, input.pull_request_id, input.idempotency_key, mergedAt, input.confirmed_at]);
      return ok({ kind: "created", closure: { id: inserted[0]!.id as PullRequestMergeClosureId, cohort_id: input.cohort_id,
        pull_request_id: input.pull_request_id, idempotency_key: input.idempotency_key, merged_at: mergedAt, confirmed_at: input.confirmed_at } });
    });
  }
}

interface V2GateProjectionRow extends GateProjectionRow {
  readonly wait_id: string;
  readonly repository_key: string | null;
  readonly run_state: CoreStatus;
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
  list_run_sessions(run_id: WorkflowRunId): Promise<readonly OperatorRunSessionAttempt[]>;
  set_run_archived(id: WorkflowRunId, archived: boolean): Promise<boolean>;
  get_invalidation_cursor(): Promise<string>;
  list_run_events(input: ListRunEventsInput): Promise<readonly RunEvent[]>;
  list_application_versions(): Promise<readonly OperatorApplicationVersionInventory[]>;
  /** The v2 run-record projection — null when the run itself does not exist; a v2-empty run (nothing materialized under it yet) is an empty `units` array, not null. */
  get_run_record_detail(run_id: WorkflowRunId): Promise<OperatorRunRecordDetail | null>;
}

export interface ListRunEventsInput {
  readonly after_sequence: string | null;
  readonly limit: number;
  /** Null keeps the global ordering used by the SSE stream. */
  readonly run_id: WorkflowRunId | null;
}

interface V2RunProjectionRow { readonly id: string; readonly title: string | null; readonly repository_keys: readonly string[]; readonly workflow_name: string; readonly status: CoreStatus; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly current_stage: string | null; readonly stage_total: string; readonly stage_complete: string; readonly attention_count: string; readonly parked_count: string; readonly updated_at: string; readonly archived: boolean }
interface V2StageProjectionRow { readonly stage_instance_id: string; readonly name: string; readonly stage_type: string; readonly operator_role: string | null; readonly status: CoreStatus; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null }
interface V2UnitProjectionRow { readonly cohort_id: string; readonly stage_instance_id: string; readonly unit_id: string; readonly params: OperatorStageUnit["params"]; readonly status: CoreStatus; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly session_id: string | null; readonly gate_step: string | null }
interface StageArtifactRow { readonly stage_instance_id: string; readonly id: string; readonly type_id: string; readonly version: number; readonly label: string | null; readonly created_at: string }
interface DiagnosisSessionRow { readonly session_id: string; readonly stage_key: string; readonly cohort_id: string; readonly attempt_number: number; readonly attempt_count: number; readonly status: CoreStatus; readonly created_at: string }
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
interface V2CohortProjectionRow { readonly cohort_id: string; readonly run_id: string; readonly workflow_name: string; readonly stage_instance_id: string; readonly stage_name: string; readonly unit_id: string; readonly params: CohortUnitParameters | null; readonly status: CoreStatus; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly artifact_revision_id: string | null; readonly verified_pr_url: string | null; readonly reconciliation: OperatorCohortSummary["pull_request_reconciliation"]; readonly updated_at: string }

/**
 * `params.artifact.repository_key` off a fan-out item this run minted
 * (`{unit_id, artifact}` — see `CohortUnitParameters` above). Shared by the
 * run-detail and cohort projections so both report the same repository key
 * from the same source, rather than one deriving it and the other
 * hardcoding `null`.
 */
function selectStageUnitRepositoryKey(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  const artifact = (params as { readonly artifact?: unknown }).artifact;
  if (typeof artifact !== "object" || artifact === null) return null;
  const repositoryKey = (artifact as { readonly repository_key?: unknown }).repository_key;
  return typeof repositoryKey === "string" ? repositoryKey : null;
}

interface RunSessionAttemptRow {
  readonly work_order_id: string; readonly session_id: string; readonly stage_instance_id: string;
  readonly stage_key: string; readonly unit_id: string; readonly reason: SessionLaunchReasonName;
  readonly work_order_state: OperatorRunSessionAttempt["work_order_state"]; readonly created_at: string;
  readonly completed_at: string | null; readonly executor_health_kind: string | null; readonly cleanup_state: string;
}

interface SessionRunLocationRow {
  readonly run_id: string; readonly stage_instance_id: string; readonly stage_key: string;
  readonly unit_id: string; readonly work_order_id: string;
}

export class PostgresOperatorProjectionRepository implements OperatorProjectionRepository, SessionHoldRepository, SessionRunLocationRepository {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly executor_application_version: string,
    private readonly adapter_roles: AdapterRoleRegistry,
  ) {}

  /**
   * Held while a **started** work order's attachment names this session and
   * that work order's workflow is PENDING or SUCCESS, with cleanup unfinished.
   * SUCCESS can mean only the initial turn ended: its cleanup workflow still
   * retains the session for review until the run record releases the work.
   *
   * The version the holder was started under is selected rather than filtered
   * on, so a workflow stranded by a version bump can be told apart from no
   * workflow at all and said out loud. Silently widening the query would leave
   * an operator with a session that became closable for no visible reason.
   * (Carried over from PR 2's deleted legacy session-hold repository, which
   * read the pre-cutover execution projection; v2 reads the run-owned
   * executor attachment instead.)
   */
  async find_session_hold(session_id: string): Promise<SessionHold | null> {
    const rows = await this.sql.query<{
      readonly work_order_id: string; readonly workflow_id: string; readonly run_id: string;
      readonly stage_instance_id: string; readonly stage_key: string; readonly unit_id: string;
      readonly application_version: string | null;
    }>(
      `SELECT work.id::text AS work_order_id, work.workflow_id, unit.run_id::text,
              unit.stage_instance_id::text, stage.stage_key, unit.unit_id, status.application_version
       FROM oakridge.executor_attachment attachment
       JOIN oakridge.work_order work ON work.id = attachment.work_order_id
       JOIN oakridge.run_unit unit ON unit.id = work.run_unit_id
       JOIN oakridge.stage_instance stage ON stage.id = unit.stage_instance_id
       JOIN dbos.workflow_status status ON status.workflow_uuid = work.workflow_id
       WHERE attachment.external_reference->>'session_id' = $1
         AND work.state = 'started' AND status.status IN ('PENDING', 'SUCCESS')
         AND attachment.cleanup_state <> 'complete'
       ORDER BY attachment.updated_at DESC LIMIT 1`,
      [session_id]);
    const row = rows[0];
    if (!row) return null;
    // v2 writes the work order id wherever v1 wrote a legacy execution id —
    // see `workOrderIdOfArtifact` (`domain/artifacts.ts`) for the same
    // convention on `artifact.execution_id`.
    const hold: SessionHold = { session_id, execution_id: row.work_order_id as ExecutionId,
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
   * The run's full session history — see the interface doc for why this
   * carries no state, status or cleanup predicate. Deliberately *not* built on
   * `find_session_hold`'s query: that one answers close-safety and its
   * predicates are those semantics, so widening it to serve navigation would
   * make kbbl refuse to close sessions that are safe to close.
   */
  async list_run_sessions(run_id: WorkflowRunId): Promise<readonly OperatorRunSessionAttempt[]> {
    const rows = await this.sql.query<RunSessionAttemptRow>(
      `SELECT attempt.id::text AS work_order_id,session.kbbl_session_id AS session_id,
              attempt.stage_instance_id::text AS stage_instance_id,stage.stage_key,cohort.cohort_key AS unit_id,
              transition.launch_reason::text AS reason,
              CASE session.status WHEN 'pending' THEN 'available' WHEN 'active' THEN 'started'
                WHEN 'blocked' THEN 'started' WHEN 'complete' THEN 'completed' ELSE 'abandoned' END AS work_order_state,
              session.created_at::text AS created_at,session.ended_at::text AS completed_at,
              NULL::text AS executor_health_kind,'not_needed'::text AS cleanup_state
       FROM oakridge.session session
       JOIN oakridge.attempt attempt ON attempt.id=session.attempt_id
       JOIN oakridge.cohort cohort ON cohort.id=attempt.cohort_id
       JOIN oakridge.stage_instance stage ON stage.id=attempt.stage_instance_id
       JOIN oakridge.run_transition transition ON transition.id=session.launch_transition_id
       WHERE session.run_id=$1 AND session.kbbl_session_id IS NOT NULL
       ORDER BY session.created_at,session.id`, [run_id]);
    return rows.map((row) => ({
      work_order_id: row.work_order_id as WorkOrderId, session_id: row.session_id,
      stage_instance_id: row.stage_instance_id as StageInstanceId, stage_key: row.stage_key,
      unit_id: row.unit_id as UnitId, reason: row.reason, work_order_state: row.work_order_state,
      created_at: row.created_at, completed_at: row.completed_at,
      executor_health_kind: row.executor_health_kind, cleanup_state: row.cleanup_state,
    }));
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
    // No `run.state='active'` filter — spec §1 rule 9 / §3.7: an open wait is
    // listed whatever the run's state, and `actionable` (derived below from
    // `run_state`) says whether a decision on it can still take effect. A
    // collection-member gate (brief_writer: one unit `"0"` fanning artifacts
    // out per cohort) reports its `collection_key` as `unit_id` instead of the
    // owning unit's own id, so an operator can tell cohort gates apart.
    const rows = await this.sql.query<V2GateProjectionRow>(
      `SELECT wait.id::text AS wait_id,run.id::text AS run_id,stage.stage_key AS stage_name,
              wait.stage_instance_id::text,cohort.cohort_key AS unit_id,revision.artifact_id::text AS artifact_revision_id,
              wait.closes_on->>'gate_step' AS gate_step,
              COALESCE(ARRAY(SELECT jsonb_array_elements_text(wait.closes_on->'actions')),ARRAY[]::text[]) AS actions,
              build_cohort.repository_key,run.status AS run_state
       FROM oakridge.wait_gate wait
       JOIN oakridge.workflow_run run ON run.id=wait.run_id
       LEFT JOIN oakridge.stage_instance stage ON stage.id=wait.stage_instance_id
       LEFT JOIN oakridge.cohort cohort ON cohort.id=wait.cohort_id
       LEFT JOIN oakridge.dev_flow_build_cohort build_cohort ON build_cohort.cohort_id=cohort.id
       LEFT JOIN LATERAL (
         SELECT linked.artifact_id FROM oakridge.wait_gate_artifact_revision linked
         WHERE linked.wait_gate_id=wait.id ORDER BY linked.artifact_id LIMIT 1
       ) revision ON true
       WHERE wait.kind='gate' AND wait.status='open' AND run.archived=false
         AND ($1::uuid IS NULL OR run.id=$1::uuid)
         AND (NOT $2::boolean OR cohort.next_actor='operator')
       ORDER BY wait.opened_at,wait.id`, [run_id ?? null, requiredAttentionOnly]);
    return rows.map((row) => ({ id: row.wait_id, stage_instance_id: row.stage_instance_id as import("../domain/primitives").StageInstanceId, gate_type: row.gate_step, run_id: row.run_id as WorkflowRunId,
      stage_name: row.stage_name, unit_id: row.unit_id as UnitId, repository_key: row.repository_key,
      artifact_revision_id: row.artifact_revision_id as ArtifactId | null, gate_step: row.gate_step, worktree: null,
      resume_actions: row.actions,
      pr_url: null, run_state: row.run_state, actionable: selectGateActionability(row.run_state) }));
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
              (SELECT count(*) FROM jsonb_object_keys(definition.definition->'graph'->'stages'))::text AS stage_total,
              (SELECT count(*) FROM oakridge.stage_instance stage WHERE stage.run_id=run.id AND stage.status='complete')::text AS stage_complete,
              ((SELECT count(*) FROM oakridge.wait_gate wait
                  JOIN oakridge.cohort cohort ON cohort.id=wait.cohort_id
                 WHERE wait.run_id=run.id AND wait.status='open' AND cohort.next_actor='operator'
                   AND run.status IN ('active','blocked') AND run.archived=false)
               + (SELECT count(*) FROM oakridge.cohort cohort
                    JOIN oakridge.dev_flow_build_cohort build_cohort ON build_cohort.cohort_id=cohort.id
                    JOIN oakridge.pull_request_verification verification
                      ON verification.id=build_cohort.current_verified_pull_request_id AND verification.invalidated_at IS NULL
                    JOIN oakridge.pull_request pull_request ON pull_request.id=verification.pull_request_id
                   WHERE cohort.run_id=run.id AND cohort.status='blocked' AND cohort.next_actor='external'
                     AND run.archived=false))::text AS attention_count,
              COALESCE(waits.parked_count,0)::text AS parked_count,
              GREATEST(run.created_at,COALESCE(run.ended_at,run.created_at),COALESCE(progress.updated_at,run.created_at))::text AS updated_at,
              run.archived
       FROM oakridge.workflow_run run
       JOIN oakridge.workflow_definition definition ON definition.id=run.workflow_definition_id
       LEFT JOIN LATERAL (SELECT stage.stage_key FROM oakridge.stage_instance stage WHERE stage.run_id=run.id AND stage.status IN ('active','blocked') ORDER BY stage.started_at DESC NULLS LAST,stage.created_at DESC LIMIT 1) current_stage ON true
       LEFT JOIN LATERAL (SELECT count(*) AS parked_count FROM oakridge.wait_gate wait WHERE wait.run_id=run.id AND wait.status='open') waits ON true
       LEFT JOIN LATERAL (SELECT max(transition.created_at) AS updated_at FROM oakridge.run_transition transition WHERE transition.run_id=run.id) progress ON true
       WHERE ($1::boolean IS NULL OR run.archived=$1::boolean) AND ($2::uuid IS NULL OR run.id=$2::uuid)
       ORDER BY updated_at DESC`, [filter === "all" ? null : filter === "archived", run_id]);
    return rows.map((row) => {
      return { id: row.id as WorkflowRunId, title: row.title, repository_keys: row.repository_keys, workflow_name: row.workflow_name,
        current_attempt_root_workflow_id: runRecordWorkflowId(row.id as WorkflowRunId), status: row.status,
        blocked_reason: row.blocked_reason, next_actor: row.next_actor, current_stage: row.current_stage,
        stage_total: Number(row.stage_total), stage_complete: Number(row.stage_complete),
        attention_count: Number(row.attention_count), parked_count: Number(row.parked_count),
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

  async get_invalidation_cursor(): Promise<string> {
    const rows = await this.sql.query<{ readonly cursor: string }>(
      `SELECT concat_ws(':',
         COALESCE((SELECT max(updated_at)::text FROM dbos.workflow_status), '0'),
         COALESCE((SELECT max(lifecycle_updated_at)::text FROM oakridge.artifact), '0'),
         COALESCE((SELECT max(created_at)::text FROM oakridge.gate_decision_audit), '0'),
         COALESCE((SELECT max(updated_at)::text FROM oakridge.executor_attachment), '0'),
         COALESCE((SELECT max(updated_at)::text FROM oakridge.epic_workflow_profile), '0'),
         COALESCE((SELECT max(created_at)::text FROM oakridge.collaboration_message), '0'),
         COALESCE((SELECT max(created_at)::text FROM oakridge.review_item), '0'),
         COALESCE((SELECT max(sequence)::text FROM oakridge.run_transition), '0')) AS cursor`, []);
    return rows[0]?.cursor ?? "0";
  }

  /** Best-effort notification feed. Durable UI state is always re-read by invalidation. */
  async list_run_events({ after_sequence, limit, run_id }: ListRunEventsInput): Promise<readonly RunEvent[]> {
    const rows = await this.sql.query<RunEventRow>(
      `SELECT transition.sequence::text,transition.operation,transition.run_id::text,
              transition.run_unit_id::text,unit.stage_instance_id::text,stage.stage_key,unit.unit_id,
              transition.work_order_id::text,transition.wait_id::text,transition.output_name,transition.collection_key,
              COALESCE(NULLIF(transition.detail->>'artifact_id','')::uuid,wait.artifact_revision_id)::text AS artifact_revision_id,
              CASE WHEN transition.detail->>'attention' IN ('required','optional','none') THEN transition.detail->>'attention' ELSE NULL END AS attention,
              CASE WHEN transition.detail->>'continuation' IN ('waiting','continuing') THEN transition.detail->>'continuation' ELSE NULL END AS continuation,
              transition.detail,transition.created_at::text
       FROM oakridge.run_transition transition
       LEFT JOIN oakridge.run_unit unit ON unit.id=transition.run_unit_id
       LEFT JOIN oakridge.stage_instance stage ON stage.id=unit.stage_instance_id
       LEFT JOIN oakridge.wait wait ON wait.id=transition.wait_id
       WHERE ($1::bigint IS NULL OR transition.sequence > $1::bigint)
         AND ($2::uuid IS NULL OR transition.run_id = $2::uuid)
       ORDER BY transition.sequence ASC LIMIT $3`, [after_sequence, run_id, limit]);
    return rows.map(projectRunEvent);
  }

  async list_application_versions(): Promise<readonly OperatorApplicationVersionInventory[]> {
    const rows = await this.sql.query<{ readonly application_version: string | null; readonly run_count: string; readonly pending_run_count: string; readonly gated_run_count: string; readonly oldest_pending_epoch_ms: string | null }>(
      // `'v2-run:'` is spelled as a SQL literal below, as in `list_unstarted_runs`
      // (`postgres-domain.ts`) — the one other place outside `runRecordWorkflowId`
      // this prefix is written.
      `SELECT status.application_version,
              count(*)::text AS run_count,
              count(*) FILTER (WHERE status.status IN ('PENDING', 'ENQUEUED', 'DELAYED'))::text AS pending_run_count,
              count(*) FILTER (WHERE gates.has_pending_gate)::text AS gated_run_count,
              min(status.created_at) FILTER (WHERE status.status IN ('PENDING', 'ENQUEUED', 'DELAYED'))::text AS oldest_pending_epoch_ms
       FROM oakridge.workflow_run run
       JOIN dbos.workflow_status status ON status.workflow_uuid = 'v2-run:' || run.id::text
       LEFT JOIN LATERAL (
         SELECT EXISTS (
           SELECT 1 FROM oakridge.wait wait
           JOIN oakridge.run_unit unit ON unit.id = wait.run_unit_id
           JOIN oakridge.artifact artifact ON artifact.id = wait.artifact_revision_id
           WHERE unit.run_id = run.id AND wait.kind = 'gate' AND wait.status = 'open' AND artifact.lifecycle_state = 'current'
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
              stage.stage_contract->>'operator_role' AS operator_role,stage.status,stage.blocked_reason,stage.next_actor
       FROM oakridge.stage_instance stage WHERE stage.run_id=$1 ORDER BY stage.created_at,stage.stage_key`, [id]);
    const unitRows = await this.sql.query<V2UnitProjectionRow>(
      `SELECT cohort.id::text AS cohort_id,cohort.stage_instance_id::text,cohort.cohort_key AS unit_id,
              cohort.stage_data AS params,cohort.status,cohort.blocked_reason,cohort.next_actor,
              current_session.kbbl_session_id AS session_id,gate.gate_step
       FROM oakridge.cohort cohort
       LEFT JOIN LATERAL (
         SELECT session.kbbl_session_id FROM oakridge.attempt attempt
         JOIN oakridge.session session ON session.attempt_id=attempt.id
         WHERE attempt.cohort_id=cohort.id ORDER BY attempt.attempt_number DESC LIMIT 1
       ) current_session ON true
       LEFT JOIN LATERAL (
         SELECT wait.closes_on->>'gate_step' AS gate_step FROM oakridge.wait_gate wait
         WHERE wait.cohort_id=cohort.id AND wait.kind='gate' AND wait.status='open'
         ORDER BY wait.opened_at LIMIT 1
       ) gate ON true
       WHERE cohort.run_id=$1 ORDER BY cohort.stage_instance_id,cohort.cohort_key`, [id]);
    const artifactRows = await this.sql.query<StageArtifactRow>(
      `SELECT owner.stage_instance_id::text,artifact.id::text,artifact.artifact_type AS type_id,artifact.revision AS version,artifact.label,
              artifact.created_at::text AS created_at
       FROM oakridge.artifact artifact JOIN oakridge.artifact_owner owner ON owner.artifact_id=artifact.id
       WHERE owner.run_id=$1 AND owner.stage_instance_id IS NOT NULL AND artifact.lifecycle IN ('current','released')
       ORDER BY owner.stage_instance_id,artifact.created_at,artifact.id`, [id]);
    const stages: OperatorStageDetail[] = stageRows.map((stage) => {
      const units: OperatorStageUnit[] = unitRows.filter((unit) => unit.stage_instance_id === stage.stage_instance_id).map((unit) => ({
        cohort_id: unit.cohort_id as CohortId, unit_id: unit.unit_id as UnitId,
        repository_key: selectStageUnitRepositoryKey(unit.params), params: unit.params,
        sid: unit.session_id,
        worktree: null, base_sha: null,
        status: unit.status, blocked_reason: unit.blocked_reason, next_actor: unit.next_actor,
        gate: unit.gate_step, admission_required: false, admitted: true,
        admission_eligible: true, admission_blocked_by: [],
      }));
      const artifacts = artifactRows.filter((artifact) => artifact.stage_instance_id === stage.stage_instance_id)
        .map((artifact): OperatorStageArtifact => ({ id: artifact.id as ArtifactId, type_id: artifact.type_id, version: artifact.version, label: artifact.label, created_at: artifact.created_at }));
      return { stage_instance_id: stage.stage_instance_id as import("../domain/primitives").StageInstanceId,
        name: stage.name, type: stage.stage_type, operator_role: stage.operator_role,
        status: stage.status, blocked_reason: stage.blocked_reason, next_actor: stage.next_actor, artifacts,
        delegated_kbbl_sid: units.find((unit) => unit.sid)?.sid ?? null, worktree: null, units };
    });
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
      const parsedDefinition = parseWorkflowDefinition(definitionJson, this.adapter_roles);
      if (!parsedDefinition.ok) throw new Error(`run ${id}'s stored workflow definition is invalid: ${parsedDefinition.error.detail}`);
      const compiled = compileWorkflowDefinition(parsedDefinition.value);
      if (!compiled.ok) throw new Error(`run ${id}'s stored workflow definition does not compile: ${compiled.error.detail}`);
      const storedStageKeys = stageRows.map((stage) => stage.name as StageKey);
      for (const stage_key of selectPendingStageOrder(compiled.value, storedStageKeys)) {
        const contract = compiled.value.stages[stage_key];
        if (!contract) continue; // selectPendingStageOrder only yields definition stage keys; defensive only.
        pendingStages.push({ stage_instance_id: stageInstanceIdFor(id, stage_key), name: stage_key, type: contract.stage_type,
          operator_role: contract.operator_role, status: "pending", blocked_reason: null, next_actor: "core",
          artifacts: [], delegated_kbbl_sid: null, worktree: null, units: [] });
      }
    }
    return { id: summary.id, title: summary.title, repository_keys: summary.repository_keys, workflow_name: summary.workflow_name, current_attempt_root_workflow_id: summary.current_attempt_root_workflow_id,
      attempts: [], status: summary.status, blocked_reason: summary.blocked_reason, next_actor: summary.next_actor,
      stages: [...stages, ...pendingStages], parked_count: summary.parked_count, updated_at: summary.updated_at,
      epic_profile: null, run_record: null };
  }

  async get_run_diagnosis(id: WorkflowRunId): Promise<OperatorRunDiagnosis | null> {
    const run = await this.getV2Run(id);
    if (!run) return null;
    const sessionRows = await this.sql.query<DiagnosisSessionRow>(
      `SELECT session.kbbl_session_id AS session_id,stage.stage_key,attempt.cohort_id::text,
              attempt.attempt_number,count(*) OVER (PARTITION BY attempt.cohort_id)::int AS attempt_count,
              session.status,session.created_at::text
       FROM oakridge.session session
       JOIN oakridge.attempt attempt ON attempt.id=session.attempt_id
       JOIN oakridge.stage_instance stage ON stage.id=session.stage_instance_id
       WHERE session.run_id=$1 AND session.kbbl_session_id IS NOT NULL
       ORDER BY session.created_at,session.id`, [id]);
    const sessions: OperatorRunDiagnosisSession[] = sessionRows.map((row) => ({
      session_id: row.session_id, stage_key: row.stage_key, cohort_id: row.cohort_id as CohortId,
      attempt_number: Number(row.attempt_number), attempt_count: Number(row.attempt_count), status: row.status,
    }));
    const current_session = [...sessions].reverse().find((session) => session.status === "active") ?? null;
    const operatorCohorts = new Set(run.stages.flatMap((stage) => stage.units
      .filter((unit) => unit.status === "blocked" && unit.next_actor === "operator")
      .map((unit) => String(unit.cohort_id))));
    const sessions_awaiting_action = sessions.filter((session) => operatorCohorts.has(String(session.cohort_id))
      && session.attempt_number === session.attempt_count);
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
    return { run, sessions, current_session, sessions_awaiting_action, active_gates, recent_artifacts, stage_progress: progress };
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
        gate_id: gate.id, gate_url: `/gates/${gate.id}/resume`, pr_url: gate.pr_url };
    });
    const items: OperatorReviewInboxItem[] = gates.map((gate) => {
      const isMerge = gate.gate_step === "merge_confirmation";
      const cohort = cohorts.find((candidate) => candidate.run_id === gate.run_id && candidate.stage_instance_id === gate.stage_instance_id && candidate.unit_id === gate.unit_id);
      return {
        id: `gate:${gate.id}:${gate.artifact_revision_id ?? "none"}:${gate.gate_step ?? "unknown"}`,
        kind: isMerge ? "merge_confirmation" : "artifact_gate", state: "actionable", run_id: gate.run_id,
        workflow_name: names.get(gate.run_id) ?? "unknown", stage_instance_id: gate.stage_instance_id ?? gate.id.slice(0, gate.id.indexOf(":")) as import("../domain/primitives").StageInstanceId,
        stage_name: gate.stage_name, unit_id: gate.unit_id, repository_key: cohort?.repository_key ?? gate.repository_key, title: cohort?.title ?? null,
        lifecycle: cohort?.lifecycle ?? "blocked", blocked_reason: cohort?.blocked_reason ?? "gate", next_actor: cohort?.next_actor ?? "operator",
        artifact_revision_id: gate.artifact_revision_id,
        artifact_url: gate.artifact_revision_id ? `/artifact_details/${gate.artifact_revision_id}` : null,
        gate_id: gate.id, gate_url: `/oakridge/gates/${gate.id}`, resume_actions: gate.resume_actions, blocked_by: [], pr_url: gate.pr_url,
      };
    });
    for (const cohort of cohorts) {
      const kind = cohort.lifecycle === "failed" ? "cohort_failed"
        : cohort.lifecycle === "blocked" && cohort.next_actor !== "operator" && cohort.next_actor !== "external" ? "cohort_blocked" : null;
      if (!kind) continue;
      items.push({ id: `${cohort.id}:${kind}`, kind, state: "blocked", run_id: cohort.run_id, workflow_name: cohort.workflow_name,
        stage_instance_id: cohort.stage_instance_id, stage_name: cohort.stage_name, unit_id: cohort.unit_id,
        repository_key: cohort.repository_key, title: cohort.title, lifecycle: cohort.lifecycle,
        blocked_reason: cohort.blocked_reason, next_actor: cohort.next_actor,
        artifact_revision_id: cohort.artifact_revision_id, artifact_url: cohort.artifact_url, gate_id: cohort.gate_id,
        gate_url: cohort.gate_url, resume_actions: [], blocked_by: cohort.admission.blocked_by, pr_url: cohort.pr_url });
    }
    // A cohort waiting on its pull request to merge is work, and it used to
    // appear nowhere in this list — the run sat on an external wait that no
    // surface offered a way to close. The poller normally closes it; the item
    // is `actionable` because an operator has to be able to when it cannot.
    for (const cohort of cohorts) {
      if (cohort.lifecycle !== "blocked" || cohort.next_actor !== "external" || cohort.pr_url === null) continue;
      items.push({ id: `${cohort.id}:pull_request_merge`, kind: "pull_request_merge", state: "actionable", run_id: cohort.run_id,
        workflow_name: cohort.workflow_name, stage_instance_id: cohort.stage_instance_id, stage_name: cohort.stage_name,
        unit_id: cohort.unit_id, repository_key: cohort.repository_key, title: cohort.title, lifecycle: cohort.lifecycle,
        blocked_reason: cohort.blocked_reason, next_actor: cohort.next_actor,
        artifact_revision_id: cohort.artifact_revision_id, artifact_url: cohort.artifact_url, gate_id: null,
        gate_url: null, resume_actions: ["confirm_merged"], blocked_by: [], pr_url: cohort.pr_url });
    }
    return { cohorts, items, attention_count: items.filter((item) => item.state === "actionable").length };
  }

  async list_cohorts(): Promise<readonly OperatorCohortSummary[]> {
    return this.listV2Cohorts();
  }

  private async listV2Cohorts(): Promise<readonly OperatorCohortSummary[]> {
    const rows = await this.sql.query<V2CohortProjectionRow>(`SELECT cohort.id::text AS cohort_id,run.id::text AS run_id,
      definition.name AS workflow_name,stage.id::text AS stage_instance_id,stage.stage_key AS stage_name,
      cohort.cohort_key AS unit_id,cohort.stage_data AS params,cohort.status,cohort.blocked_reason,cohort.next_actor,
      artifact.id::text AS artifact_revision_id,
      pull_request.url AS verified_pr_url,CASE WHEN pull_request.id IS NULL THEN NULL ELSE jsonb_build_object(
        'repository_key',build_cohort.repository_key,
        'observation',jsonb_build_object('provider',pull_request.provider,'owner',pull_request.owner,'name',pull_request.name,
          'number',pull_request.forge_pull_request_id,'url',pull_request.url,'head_branch',observation.head_ref,
          'base_branch',observation.base_ref,'head_sha',observation.head_sha,'state',observation.state,
          'source',observation.source,'observed_at',observation.observed_at,'merged_at',observation.merged_at),
        'mismatch',NULL,'completed_at',merge_closure.confirmed_at,'updated_at',observation.recorded_at) END AS reconciliation,
      GREATEST(cohort.created_at,COALESCE(cohort.ended_at,cohort.created_at),COALESCE(artifact.created_at,cohort.created_at))::text AS updated_at
      FROM oakridge.cohort cohort JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
      JOIN oakridge.workflow_run run ON run.id=cohort.run_id JOIN oakridge.workflow_definition definition ON definition.id=run.workflow_definition_id
      LEFT JOIN LATERAL (SELECT candidate.* FROM oakridge.artifact candidate
        JOIN oakridge.artifact_owner owner ON owner.artifact_id=candidate.id
        WHERE owner.cohort_id=cohort.id AND candidate.lifecycle IN ('current','released')
        ORDER BY candidate.created_at DESC LIMIT 1) artifact ON true
      LEFT JOIN oakridge.dev_flow_build_cohort build_cohort ON build_cohort.cohort_id=cohort.id
      LEFT JOIN oakridge.pull_request_verification verification ON verification.id=build_cohort.current_verified_pull_request_id AND verification.invalidated_at IS NULL
      LEFT JOIN oakridge.pull_request pull_request ON pull_request.id=verification.pull_request_id
      LEFT JOIN LATERAL (SELECT latest.* FROM oakridge.pull_request_observation latest
        WHERE latest.pull_request_id=verification.pull_request_id AND latest.head_sha=verification.verified_head_sha
        ORDER BY latest.observed_at DESC,latest.recorded_at DESC,latest.id DESC LIMIT 1) observation ON true
      LEFT JOIN oakridge.pull_request_merge_closure merge_closure ON merge_closure.cohort_id=build_cohort.cohort_id
      WHERE run.archived=false ORDER BY updated_at DESC`, []);
    return rows.map((row) => {
      const artifact = row.artifact_revision_id as ArtifactId | null; const cohort = row.params?.artifact ?? null;
      return { id: row.cohort_id,run_id: row.run_id as WorkflowRunId,workflow_name: row.workflow_name,stage_instance_id: row.stage_instance_id as import("../domain/primitives").StageInstanceId,stage_name: row.stage_name,unit_id: row.unit_id as UnitId,repository_key: selectStageUnitRepositoryKey(row.params),title: cohort?.title ?? null,lifecycle: row.status,blocked_reason: row.blocked_reason,next_actor: row.next_actor,completion: { build_complete: artifact !== null, assessment_complete: row.status === "complete" },admission: { required: false, admitted: true, eligible: true, blocked_by: [] },artifact_revision_id: artifact,artifact_url: artifact ? `/artifact_details/${artifact}` : null,gate_id: null,gate_url: null,pr_url: row.verified_pr_url,pull_request_reconciliation: row.reconciliation,updated_at: row.updated_at };
    });
  }
}
