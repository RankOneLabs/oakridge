import type { StageInstanceId, UnitId, CohortId } from "../domain/primitives";
import type { DevFlowBuildCohort, ImplementationPublicationEvidence } from "../domain/cohort-pull-request";
import type { PullRequest, PullRequestId, PullRequestMergeClosure, PullRequestMergeClosureId, PullRequestObservation, PullRequestObservationId, PullRequestVerificationId, StoredPullRequestObservation } from "../domain/pull-request";
import { err, ok, type Result } from "../domain/primitives";
import type { CurrentVerifiedCohortPullRequest, DevFlowPullRequestRepository } from "./repositories";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";
import type { CohortDetail, CohortDetailContributor, OperatorRunDetail } from "../domain/operator-projections";

interface DevFlowCohortDetailRow {
  readonly cohort_id: string;
  readonly url: string | null;
  readonly state: string | null;
  readonly merged_at: string | null;
  readonly verified_head_sha: string | null;
  readonly merged_head_sha: string | null;
}

/** The adapter's only projection hook into generic cohort details. */
export class PostgresDevFlowCohortDetailContributor implements CohortDetailContributor {
  readonly stage_type = "delegated_session";
  constructor(private readonly sql: TransactionalSqlExecutor) {}

  async read(cohort_ids: readonly CohortId[]): Promise<ReadonlyMap<CohortId, CohortDetail>> {
    if (cohort_ids.length === 0) return new Map();
    const rows = await this.sql.query<DevFlowCohortDetailRow>(`SELECT build.cohort_id::text,
      request.url,observation.state,COALESCE(closure.confirmed_at,observation.merged_at)::text AS merged_at,
      verification.verified_head_sha,merged.head_sha AS merged_head_sha
      FROM dev_flow.build_cohort build
      LEFT JOIN dev_flow.pull_request_verification verification
        ON verification.id=build.current_verified_pull_request_id AND verification.invalidated_at IS NULL
      LEFT JOIN dev_flow.pull_request request ON request.id=verification.pull_request_id
      LEFT JOIN LATERAL (SELECT latest.* FROM dev_flow.pull_request_observation latest
        WHERE latest.pull_request_id=verification.pull_request_id AND latest.head_sha=verification.verified_head_sha
        ORDER BY latest.observed_at DESC,latest.recorded_at DESC,latest.id DESC LIMIT 1) observation ON true
      LEFT JOIN dev_flow.pull_request_merge_closure closure ON closure.cohort_id=build.cohort_id
      LEFT JOIN LATERAL (SELECT latest.head_sha FROM dev_flow.pull_request_observation latest
        WHERE latest.pull_request_id=closure.pull_request_id AND latest.merged_at IS NOT NULL
        ORDER BY latest.observed_at DESC,latest.recorded_at DESC LIMIT 1) merged ON true
      WHERE build.cohort_id=ANY($1::uuid[])`, [cohort_ids]);
    return new Map(rows.map((row) => [row.cohort_id as CohortId, {
      links: row.url ? [{ key: "pull_request", label: "Open pull request", url: row.url }] : [],
      facts: [
        ...(row.state ? [{ key: "review_state", label: "Review state", value: row.state }] : []),
        ...(row.merged_at ? [{ key: "merged_at", label: "Merged at", value: row.merged_at }] : []),
        ...(row.merged_head_sha && row.verified_head_sha && row.merged_head_sha !== row.verified_head_sha
          ? [{ key: "merge_head_drift", label: "Merged head differs from verified head",
            value: `${row.verified_head_sha} → ${row.merged_head_sha}` }] : []),
      ],
    }]));
  }

  async cursor(): Promise<string> {
    const rows = await this.sql.query<{ readonly cursor: string }>(`SELECT GREATEST(
      COALESCE((SELECT max(updated_at)::text FROM dev_flow.build_cohort),'0'),
      COALESCE((SELECT max(recorded_at)::text FROM dev_flow.pull_request_observation),'0'),
      COALESCE((SELECT max(verified_at)::text FROM dev_flow.pull_request_verification),'0'),
      COALESCE((SELECT max(confirmed_at)::text FROM dev_flow.pull_request_merge_closure),'0')) AS cursor`, []);
    return rows[0]?.cursor ?? "0";
  }

  async enrich_run(run: OperatorRunDetail): Promise<OperatorRunDetail> {
    const rows = await this.sql.query<{ readonly cohort_id: string; readonly accepted_head_sha: string; readonly merged_head_sha: string }>(
      `SELECT build.cohort_id::text,verification.verified_head_sha AS accepted_head_sha,
              observation.head_sha AS merged_head_sha
       FROM dev_flow.build_cohort build
       JOIN oakridge.cohort cohort ON cohort.id=build.cohort_id
       JOIN dev_flow.pull_request_verification verification ON verification.id=build.current_verified_pull_request_id
       JOIN dev_flow.pull_request_merge_closure closure ON closure.cohort_id=build.cohort_id
       JOIN LATERAL (SELECT head_sha FROM dev_flow.pull_request_observation
         WHERE pull_request_id=closure.pull_request_id AND merged_at IS NOT NULL
         ORDER BY observed_at DESC,recorded_at DESC LIMIT 1) observation ON true
       WHERE cohort.run_id=$1 AND observation.head_sha IS DISTINCT FROM verification.verified_head_sha`, [run.id]);
    const drift = new Map(rows.map((row) => [row.cohort_id,
      { accepted_head_sha: row.accepted_head_sha, merged_head_sha: row.merged_head_sha }]));
    return { ...run, stages: run.stages.map((stage) => stage.type !== this.stage_type ? stage : ({
      ...stage, units: stage.units.map((unit) => ({
        ...unit, ...(drift.has(unit.cohort_id) ? { merge_head_drift: drift.get(unit.cohort_id) } : {}),
      })),
    })) };
  }
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

type ObservePullRequestInput = Parameters<DevFlowPullRequestRepository["observe"]>[0];
type StoredObservationIdentity = Awaited<ReturnType<DevFlowPullRequestRepository["observe"]>>;
type BindVerifiedPullRequestInput = Parameters<DevFlowPullRequestRepository["bind_verified"]>[0];
type BindVerifiedPullRequestResult = Awaited<ReturnType<DevFlowPullRequestRepository["bind_verified"]>>;

/** PostgreSQL implementation of the shared cohort/final-stage PR entity. */
export class PostgresDevFlowPullRequestRepository implements DevFlowPullRequestRepository {
  constructor(private readonly sql: TransactionalSqlExecutor) {}

  async create_cohort(cohort: DevFlowBuildCohort): Promise<Result<DevFlowBuildCohort,
    { readonly kind: "cohort_not_stored" | "identity_conflict" | "storage_failed"; readonly detail: string }>> {
    try {
    return await this.sql.transaction(async (tx) => {
      await tx.query(`INSERT INTO dev_flow.build_cohort
        (cohort_id,stage_instance_id,cohort_key,repository_key,repository_path,canonical_ref,expected_pr_base,recorded_head_sha,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (cohort_id) DO NOTHING`,
      [cohort.cohort_id, cohort.stage_instance_id, cohort.cohort_key, cohort.repository_key, cohort.repository_path,
        cohort.canonical_ref, cohort.expected_pr_base, cohort.recorded_head_sha, cohort.created_at, cohort.updated_at]);
      const rows = await tx.query<BuildCohortRow>(`SELECT ${BUILD_COHORT_COLUMNS}
        FROM dev_flow.build_cohort WHERE cohort_id=$1`, [cohort.cohort_id]);
      const stored = rows[0];
      if (!stored) return err({ kind: "cohort_not_stored" as const, detail: `build cohort '${cohort.cohort_id}' was not stored` });
      const result = buildCohortFromRow(stored);
      const immutableMatches = result.stage_instance_id === cohort.stage_instance_id && result.cohort_key === cohort.cohort_key
        && result.repository_key === cohort.repository_key && result.repository_path === cohort.repository_path
        && result.canonical_ref === cohort.canonical_ref && result.expected_pr_base === cohort.expected_pr_base;
      if (!immutableMatches) return err({ kind: "identity_conflict" as const,
        detail: `build cohort '${cohort.cohort_id}' already exists with different branch roles` });
      return ok(result);
    });
    } catch (error) {
      return err({ kind: "storage_failed", detail: `creating build cohort '${cohort.cohort_id}' failed: ${String(error)}` });
    }
  }

  async advance_cohort_head(input: { readonly cohort_id: CohortId; readonly expected_head_sha: string; readonly next_head_sha: string; readonly advanced_at: string }): Promise<Result<DevFlowBuildCohort, { readonly kind: "cohort_not_found" | "ref_lease_mismatch"; readonly detail: string }>> {
    const rows = await this.sql.query<BuildCohortRow>(`UPDATE dev_flow.build_cohort
      SET recorded_head_sha=$3,pending_head_sha=NULL,updated_at=$4
      WHERE cohort_id=$1 AND recorded_head_sha=$2 AND pending_head_sha=$3
      RETURNING ${BUILD_COHORT_COLUMNS}`, [input.cohort_id, input.expected_head_sha, input.next_head_sha, input.advanced_at]);
    if (rows[0]) return ok(buildCohortFromRow(rows[0]));
    const current = await this.sql.query<{ readonly recorded_head_sha: string }>(
      "SELECT recorded_head_sha FROM dev_flow.build_cohort WHERE cohort_id=$1", [input.cohort_id]);
    if (!current[0]) return err({ kind: "cohort_not_found", detail: `build cohort '${input.cohort_id}' was not found` });
    return err({ kind: "ref_lease_mismatch", detail: `stored cohort head moved from '${input.expected_head_sha}' to '${current[0].recorded_head_sha}'` });
  }

  async begin_cohort_advance(input: { readonly cohort_id: CohortId; readonly expected_head_sha: string; readonly next_head_sha: string; readonly prepared_at: string }): Promise<Result<void, { readonly kind: "cohort_not_found" | "ref_lease_mismatch"; readonly detail: string }>> {
    const rows = await this.sql.query<{ readonly cohort_id: string }>(`UPDATE dev_flow.build_cohort
      SET pending_head_sha=$3,updated_at=$4
      WHERE cohort_id=$1 AND recorded_head_sha=$2 AND (pending_head_sha IS NULL OR pending_head_sha=$3)
      RETURNING cohort_id::text`, [input.cohort_id, input.expected_head_sha, input.next_head_sha, input.prepared_at]);
    if (rows[0]) return ok(undefined);
    const current = await this.sql.query<{ readonly recorded_head_sha: string }>(
      "SELECT recorded_head_sha FROM dev_flow.build_cohort WHERE cohort_id=$1", [input.cohort_id]);
    if (!current[0]) return err({ kind: "cohort_not_found", detail: `build cohort '${input.cohort_id}' was not found` });
    return err({ kind: "ref_lease_mismatch", detail: "another cohort ref advance is already pending or the stored head changed" });
  }

  async find_cohort_for_unit(stage_instance_id: StageInstanceId, unit_id: UnitId): Promise<DevFlowBuildCohort | null> {
    const rows = await this.sql.query<BuildCohortRow>(`SELECT ${BUILD_COHORT_COLUMNS}
      FROM dev_flow.build_cohort WHERE stage_instance_id=$1 AND cohort_key=$2`, [stage_instance_id, unit_id]);
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
      FROM dev_flow.build_cohort cohort
      JOIN dev_flow.pull_request_verification verification
        ON verification.id=cohort.current_verified_pull_request_id AND verification.invalidated_at IS NULL
      JOIN dev_flow.pull_request pull_request ON pull_request.id=verification.pull_request_id
      JOIN LATERAL (SELECT latest.* FROM dev_flow.pull_request_observation latest
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

  async observe(input: ObservePullRequestInput): Promise<StoredObservationIdentity> {
    return this.sql.transaction((tx) => PostgresDevFlowPullRequestRepository.observe_in(tx, input));
  }

  static async observe_in(tx: SqlExecutor, input: ObservePullRequestInput): Promise<StoredObservationIdentity> {
    const pullRequests = await tx.query<{ readonly id: string }>(`INSERT INTO dev_flow.pull_request
      (id,provider,owner,name,forge_pull_request_id,url,created_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6)
      ON CONFLICT (provider,lower(owner),lower(name),forge_pull_request_id) DO UPDATE SET url=EXCLUDED.url
      RETURNING id::text`, [input.observation.provider, input.observation.owner,
      input.observation.name, input.observation.number, input.observation.url, input.recorded_at]);
    const pullRequestId = pullRequests[0]!.id as PullRequestId;
    const observations = await tx.query<{ readonly id: string }>(`INSERT INTO dev_flow.pull_request_observation
      (id,pull_request_id,head_ref,base_ref,head_sha,state,source,observed_at,merged_at,recorded_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text`,
    [pullRequestId, input.observation.head_branch, input.observation.base_branch, input.observation.head_sha,
      input.observation.state, input.observation.source, input.observation.observed_at, input.observation.merged_at, input.recorded_at]);
    return { pull_request_id: pullRequestId, observation_id: observations[0]!.id as PullRequestObservationId };
  }

  async bind_verified(input: BindVerifiedPullRequestInput): Promise<BindVerifiedPullRequestResult> {
    return this.sql.transaction((tx) => PostgresDevFlowPullRequestRepository.bind_verified_in(tx, input));
  }

  static async bind_verified_in(tx: SqlExecutor, input: BindVerifiedPullRequestInput): Promise<BindVerifiedPullRequestResult> {
    const rows = await tx.query<{ readonly current_verified_pull_request_id: string | null }>(
      "SELECT current_verified_pull_request_id::text FROM dev_flow.build_cohort WHERE cohort_id=$1 FOR UPDATE", [input.cohort_id]);
    if (!rows[0]) return err({ kind: "build_cohort_not_found", detail: "build cohort is missing" });
    const current = rows[0].current_verified_pull_request_id;
    const prior = current === null ? null : (await tx.query<{ readonly pull_request_id: string }>(
      "SELECT pull_request_id::text FROM dev_flow.pull_request_verification WHERE id=$1", [current]))[0] ?? null;
    const isHeadAdvance = prior?.pull_request_id === input.pull_request_id;
    if (current !== null && !isHeadAdvance && input.replace_verification_id === null) return err({ kind: "replacement_required", detail: "cohort already has a verified pull request; replacement must name it" });
    if (current !== null && !isHeadAdvance && current !== input.replace_verification_id) return err({ kind: "replacement_conflict", detail: "current verified pull request changed before replacement" });
    if (current !== null) {
      await tx.query("UPDATE dev_flow.pull_request_verification SET invalidated_at=$2,invalidation_reason=$3 WHERE id=$1 AND invalidated_at IS NULL",
        [current, input.verified_at, isHeadAdvance ? "head_changed" : "replaced"]);
    }
    const inserted = await tx.query<{ readonly id: string }>(`INSERT INTO dev_flow.pull_request_verification
      (id,cohort_id,pull_request_id,observation_id,verified_head_sha,verified_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5) RETURNING id::text`,
    [input.cohort_id, input.pull_request_id, input.observation_id, input.verified_head_sha, input.verified_at]);
    const id = inserted[0]!.id as PullRequestVerificationId;
    await tx.query("UPDATE dev_flow.build_cohort SET current_verified_pull_request_id=$2,updated_at=$3 WHERE cohort_id=$1", [input.cohort_id, id, input.verified_at]);
    return ok({ id, binding: current === null ? "created" : isHeadAdvance ? "head_advanced" : "replaced" });
  }

  async confirm_merge(input: { readonly cohort_id: CohortId; readonly pull_request_id: PullRequestId; readonly idempotency_key: string; readonly merged_at: string; readonly confirmed_at: string }): Promise<Result<{ readonly kind: "created" | "replayed"; readonly closure: PullRequestMergeClosure }, { readonly kind: "idempotency_conflict" | "pull_request_not_current" | "missing_merged_evidence"; readonly detail: string }>> {
    return this.sql.transaction(async (tx) => {
      const cohorts = await tx.query<{ readonly current_verified_pull_request_id: string | null }>(
        "SELECT current_verified_pull_request_id::text FROM dev_flow.build_cohort WHERE cohort_id=$1 FOR UPDATE", [input.cohort_id]);
      if (!cohorts[0]?.current_verified_pull_request_id) return err({ kind: "pull_request_not_current", detail: "cohort has no current verified pull request" });
      const existing = await tx.query<{ readonly id: string; readonly cohort_id: string; readonly pull_request_id: string; readonly idempotency_key: string; readonly merged_at: string; readonly confirmed_at: string }>(
        "SELECT id::text,cohort_id::text,pull_request_id::text,idempotency_key,merged_at::text,confirmed_at::text FROM dev_flow.pull_request_merge_closure WHERE cohort_id=$1 FOR UPDATE", [input.cohort_id]);
      const row = existing[0];
      if (row) {
        if (row.idempotency_key !== input.idempotency_key) return err({ kind: "idempotency_conflict", detail: "cohort merge was already confirmed with a different idempotency key" });
        return ok({ kind: "replayed", closure: { id: row.id as PullRequestMergeClosureId, cohort_id: row.cohort_id as CohortId,
          pull_request_id: row.pull_request_id as PullRequestId, idempotency_key: row.idempotency_key, merged_at: row.merged_at, confirmed_at: row.confirmed_at } });
      }
      const evidence = await tx.query<{ readonly pull_request_id: string; readonly merged_at: string | null }>(`SELECT
        verification.pull_request_id::text,observation.merged_at::text
        FROM dev_flow.pull_request_verification verification
        JOIN LATERAL (SELECT latest.merged_at FROM dev_flow.pull_request_observation latest
          WHERE latest.pull_request_id=verification.pull_request_id AND latest.head_sha=verification.verified_head_sha
          ORDER BY latest.observed_at DESC,latest.recorded_at DESC,latest.id DESC LIMIT 1) observation ON true
        WHERE verification.id=$1 AND verification.cohort_id=$2 AND verification.invalidated_at IS NULL`,
      [cohorts[0].current_verified_pull_request_id, input.cohort_id]);
      if (evidence[0]?.pull_request_id !== input.pull_request_id) {
        return err({ kind: "pull_request_not_current", detail: "pull request is no longer the cohort's current verified link" });
      }
      if (!evidence[0].merged_at) return err({ kind: "missing_merged_evidence", detail: "current verified pull request has no merged observation" });
      const mergedAt = evidence[0].merged_at;
      const inserted = await tx.query<{ readonly id: string }>(`INSERT INTO dev_flow.pull_request_merge_closure
        (id,cohort_id,pull_request_id,idempotency_key,merged_at,confirmed_at)
        VALUES (gen_random_uuid(),$1,$2,$3,$4,$5) RETURNING id::text`,
      [input.cohort_id, input.pull_request_id, input.idempotency_key, mergedAt, input.confirmed_at]);
      return ok({ kind: "created", closure: { id: inserted[0]!.id as PullRequestMergeClosureId, cohort_id: input.cohort_id,
        pull_request_id: input.pull_request_id, idempotency_key: input.idempotency_key, merged_at: mergedAt, confirmed_at: input.confirmed_at } });
    });
  }
}

/** Commit verified PR evidence within the artifact transaction, after execution fencing. */
interface RecordImplementationPublicationInput {
  readonly cohort_id: CohortId;
  readonly enrichment: import("../domain/primitives").JsonValue | null;
  readonly at: string;
}

export const recordImplementationPublicationIn = async (tx: SqlExecutor, input: RecordImplementationPublicationInput):
  Promise<Result<void, { readonly code: string; readonly detail: string }>> => {
  const evidence = input.enrichment as unknown as ImplementationPublicationEvidence | null;
  if (!evidence?.pr) return err({ code: "pr_verification_failed", detail: "verified PR observation is missing" });
  const observation = evidence.pr;
  if (typeof evidence.origin_head_sha !== "string" || observation.head_sha !== evidence.origin_head_sha)
    return err({ code: "pr_verification_failed", detail: "verified PR evidence disagrees with the pushed head" });
  const current = await tx.query<{ readonly pull_request_id: string; readonly verified_head_sha: string }>(
    `SELECT verification.pull_request_id::text,verification.verified_head_sha
     FROM dev_flow.build_cohort cohort
     LEFT JOIN dev_flow.pull_request_verification verification ON verification.id=cohort.current_verified_pull_request_id
     WHERE cohort.cohort_id=$1 FOR UPDATE OF cohort`, [input.cohort_id]);
  const stored = await PostgresDevFlowPullRequestRepository.observe_in(tx, { observation, recorded_at: input.at });
  if (current[0]?.pull_request_id === stored.pull_request_id && current[0].verified_head_sha === evidence.origin_head_sha)
    return ok(undefined);
  const bound = await PostgresDevFlowPullRequestRepository.bind_verified_in(tx, { ...stored, cohort_id: input.cohort_id,
    verified_head_sha: evidence.origin_head_sha, verified_at: input.at,
    replace_verification_id: typeof evidence.replace_verification_id === "string"
      ? evidence.replace_verification_id as PullRequestVerificationId : null });
  return bound.ok ? ok(undefined) : err({ code: "pr_verification_failed", detail: bound.error.detail });
};
