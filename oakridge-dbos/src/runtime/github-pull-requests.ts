/**
 * Watching GitHub for the merges a run is waiting on.
 *
 * A cohort parked in `github_review` is waiting for a human to merge its pull
 * request somewhere Oakridge cannot see. Polling is how it finds out. The
 * operator's confirm-merged button exists for when this cannot run at all — no
 * token, a repository the token cannot read, a merge the API does not reflect —
 * so the poller is allowed to be absent, and a backend without a token simply
 * does not start one.
 *
 * Every observation goes through the same reconciliation the manual path uses.
 * Nothing here decides that a wait is over; it only reports what GitHub said.
 */
import type { PullRequestObservation } from "../domain/pull-request";
import { parseGithubPullRequestIdentity } from "../domain/pull-request";
import { err, ok, type Result } from "../domain/primitives";
import type { StageInstanceId, UnitId } from "../domain/primitives";
import type { OperatorCohortSummary } from "../domain/operator-projections";
import type { CohortId, RunTransitionId } from "../domain/primitives";
import type { StageEventApplier } from "../storage/apply-stage-event";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";
import { findCohortPullRequestExpectation, reconcileCohortEvidence, type CohortPullRequestDependencies, type CohortPullRequestResolution } from "./cohort-pull-request";

/** Reads one pull request's current state. Absent when it cannot be read. */
export interface PullRequestReader {
  read(owner: string, name: string, number: number): Promise<Result<PullRequestObservation | null, PullRequestReadError>>;
}

export interface PullRequestReadError {
  readonly kind: "unavailable";
  readonly status: number | null;
  readonly detail: string;
}

export interface GithubPullRequestReaderConfig {
  readonly token: string;
  readonly api_base_url?: string;
  readonly user_agent?: string;
}

interface GithubPullRequestPayload {
  readonly number?: unknown;
  readonly html_url?: unknown;
  readonly state?: unknown;
  readonly merged?: unknown;
  readonly merged_at?: unknown;
  readonly head?: { readonly ref?: unknown; readonly sha?: unknown } | null;
  readonly base?: { readonly ref?: unknown } | null;
}

const asString = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * GitHub's REST API, read-only.
 *
 * `merged` is trusted over `state` — a merged pull request reports
 * `state: "closed"`, and reading only the state would file every merge as a
 * close without merge.
 */
export class GithubPullRequestReader implements PullRequestReader {
  private readonly apiBaseUrl: string;
  constructor(private readonly config: GithubPullRequestReaderConfig, private readonly http: typeof fetch = fetch) {
    this.apiBaseUrl = (config.api_base_url ?? "https://api.github.com").replace(/\/+$/, "");
  }

  async read(owner: string, name: string, number: number): Promise<Result<PullRequestObservation | null, PullRequestReadError>> {
    let response: Response;
    try { response = await this.http(`${this.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.config.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": this.config.user_agent ?? "oakridge",
      },
    }); } catch (error) { return err({ kind: "unavailable", status: null, detail: String(error) }); }
    if (response.status === 404) return ok(null);
    if (!response.ok) return err({ kind: "unavailable", status: response.status,
      detail: `GitHub pull request read failed (${response.status})` });
    let payload: GithubPullRequestPayload;
    try { payload = await response.json() as GithubPullRequestPayload; }
    catch (error) { return err({ kind: "unavailable", status: response.status, detail: String(error) }); }
    const url = asString(payload.html_url);
    const headBranch = asString(payload.head?.ref);
    const baseBranch = asString(payload.base?.ref);
    if (!url || !headBranch || !baseBranch || typeof payload.number !== "number") return err({
      kind: "unavailable", status: response.status, detail: "GitHub returned an invalid pull request" });
    const mergedAt = asString(payload.merged_at);
    const merged = payload.merged === true || mergedAt !== null;
    return ok({
      provider: "github", owner, name, number: payload.number, url,
      head_branch: headBranch, base_branch: baseBranch, head_sha: asString(payload.head?.sha),
      state: merged ? "merged" : payload.state === "closed" ? "closed_unmerged" : "open",
      source: "poll", observed_at: new Date().toISOString(), merged_at: mergedAt,
    });
  }
}

export interface CohortPullRequestPollDependencies extends CohortPullRequestDependencies {
  /** The cohorts the run is currently waiting on, from the operator projection. */
  list_cohorts(): Promise<readonly OperatorCohortSummary[]>;
  readonly reader: PullRequestReader;
}

export interface CohortPollOutcome {
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: UnitId;
  readonly resolution: CohortPullRequestResolution | { readonly kind: "unreadable" } | { readonly kind: "refused"; readonly detail: string };
}

/** Cohorts whose handoff is parked on the external review, and nothing else. */
export const selectCohortsAwaitingReview = (cohorts: readonly OperatorCohortSummary[]): readonly OperatorCohortSummary[] =>
  cohorts.filter((cohort) => cohort.lifecycle === "blocked" && cohort.blocked_reason === "external"
    && cohort.next_actor === "external");

/**
 * One sweep. Errors are per-cohort: a pull request that cannot be read, or a
 * mismatch that has to be recorded and looked at, must not stop the sweep from
 * reaching the cohorts behind it.
 */
export const pollCohortPullRequests = async (dependencies: CohortPullRequestPollDependencies): Promise<readonly CohortPollOutcome[]> => {
  const outcomes: CohortPollOutcome[] = [];
  for (const cohort of selectCohortsAwaitingReview(await dependencies.list_cohorts())) {
    const expectation = await findCohortPullRequestExpectation(dependencies, cohort.stage_instance_id, cohort.unit_id);
    if (!expectation.ok) {
      outcomes.push({ stage_instance_id: cohort.stage_instance_id, unit_id: cohort.unit_id, resolution: { kind: "refused", detail: expectation.error.detail } });
      continue;
    }
    const identity = parseGithubPullRequestIdentity(expectation.value.url);
    if (!identity) {
      outcomes.push({ stage_instance_id: cohort.stage_instance_id, unit_id: cohort.unit_id, resolution: { kind: "refused", detail: "reported pull request URL is not a canonical GitHub URL" } });
      continue;
    }
    const reading = await dependencies.reader.read(identity.owner, identity.name, identity.number).catch(() => null);
    const observation = reading?.ok ? reading.value : null;
    if (!observation) {
      outcomes.push({ stage_instance_id: cohort.stage_instance_id, unit_id: cohort.unit_id, resolution: { kind: "unreadable" } });
      continue;
    }
    const reconciled = await reconcileCohortEvidence(dependencies, cohort.stage_instance_id, cohort.unit_id, { kind: "observation", observation });
    outcomes.push({
      stage_instance_id: cohort.stage_instance_id, unit_id: cohort.unit_id,
      resolution: reconciled.ok ? reconciled.value.resolution : { kind: "refused", detail: reconciled.error.detail },
    });
  }
  return outcomes;
};

interface StagePullRequestRow {
  readonly cohort_id: string;
  readonly verification_id: string;
  readonly durable_version: string;
  readonly state: string;
  readonly owner: string;
  readonly name: string;
  readonly number: number;
  readonly latest_state: string | null;
  readonly latest_merged_at: string | null;
  readonly latest_head_sha: string | null;
  readonly latest_base_ref: string | null;
}

interface CurrentStagePullRequest {
  readonly id: string;
  readonly verification_id: string;
  readonly durable_version: string;
  readonly state: string;
}

export interface StagePullRequestPollOutcome {
  readonly cohort_id: CohortId;
  readonly state: string;
  readonly kind: "unchanged" | "observed" | "unavailable";
}

export interface StagePullRequestPollDependencies {
  readonly sql: TransactionalSqlExecutor;
  readonly reader: PullRequestReader;
  readonly stage_events: StageEventApplier;
}

export const pollStagePullRequests = async (dependencies: StagePullRequestPollDependencies,
  only_cohort_id: CohortId | null = null): Promise<readonly StagePullRequestPollOutcome[]> => {
  const rows = await dependencies.sql.query<StagePullRequestRow>(
    `SELECT cohort.id::text AS cohort_id,cohort.state,pr.owner,pr.name,
            verification.id::text AS verification_id,cohort.durable_version::text,
            pr.forge_pull_request_id AS number,
            latest.state AS latest_state,latest.merged_at::text AS latest_merged_at,
            latest.head_sha AS latest_head_sha,latest.base_ref AS latest_base_ref
     FROM oakridge.cohort cohort JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
     JOIN dev_flow.build_cohort build ON build.cohort_id=cohort.id
     JOIN dev_flow.pull_request_verification verification ON verification.id=build.current_verified_pull_request_id
     JOIN dev_flow.pull_request pr ON pr.id=verification.pull_request_id
     LEFT JOIN LATERAL (SELECT observation.state,observation.merged_at,observation.head_sha,observation.base_ref
       FROM dev_flow.pull_request_observation observation WHERE observation.pull_request_id=pr.id
       ORDER BY observation.observed_at DESC,observation.recorded_at DESC LIMIT 1) latest ON true
     WHERE stage.stage_type='delegated_session' AND stage.stage_key='build'
       AND cohort.state IN ('awaiting_merge','pr_closed')
       AND ($1::uuid IS NULL OR cohort.id=$1)
     ORDER BY cohort.id`, [only_cohort_id]);
  const outcomes: StagePullRequestPollOutcome[] = [];
  for (const row of rows) {
    const cohort_id = row.cohort_id as CohortId;
    const read = await dependencies.reader.read(row.owner, row.name, row.number);
    if (!read.ok || read.value === null) {
      outcomes.push({ cohort_id, state: row.state, kind: "unavailable" });
      continue;
    }
    const observation = read.value;
    const changed = observation.state !== row.latest_state || observation.merged_at !== row.latest_merged_at
      || observation.head_sha !== row.latest_head_sha || observation.base_branch !== row.latest_base_ref;
    if (!changed) {
      outcomes.push({ cohort_id, state: row.state, kind: "unchanged" });
      continue;
    }
    const transition_ids: RunTransitionId[] = [];
    const outcome = await dependencies.sql.transaction(async (tx): Promise<StagePullRequestPollOutcome> => {
      await dependencies.stage_events.lock_stage_cohorts_in(tx, cohort_id);
      const pull = await tx.query<CurrentStagePullRequest>(
        `SELECT verification.pull_request_id::text AS id,verification.id::text AS verification_id,
                cohort.durable_version::text,cohort.state
         FROM dev_flow.build_cohort build
         JOIN oakridge.cohort cohort ON cohort.id=build.cohort_id
         JOIN dev_flow.pull_request_verification verification ON verification.id=build.current_verified_pull_request_id
         WHERE build.cohort_id=$1`, [cohort_id]);
      const current = pull[0];
      // The GitHub read happened outside the lock. A retry, replacement PR or
      // another observer may have advanced this cohort while it was in flight.
      if (!current || current.verification_id !== row.verification_id
        || current.durable_version !== row.durable_version) {
        return { cohort_id, state: current?.state ?? row.state, kind: "unchanged" };
      }
      await tx.query(
        `INSERT INTO dev_flow.pull_request_observation
           (id,pull_request_id,head_ref,base_ref,head_sha,state,source,observed_at,merged_at,recorded_at)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'poll',$6::timestamptz,$7::timestamptz,clock_timestamp())`,
        [current.id, observation.head_branch, observation.base_branch, observation.head_sha,
          observation.state, observation.observed_at, observation.merged_at]);
      const applied = await dependencies.stage_events.apply_in(tx, cohort_id,
        { kind: "external_observed", source: "pr_watcher" as import("../domain/stage-machine").ObserverName,
          observation: observation as unknown as import("../domain/primitives").JsonValue }, transition_ids);
      if (!applied.ok || applied.value.kind === "refused") throw new Error(`PR observation refused: ${JSON.stringify(applied)}`);
      return { cohort_id, state: applied.value.kind === "applied" ? applied.value.to : row.state,
        kind: "observed" };
    });
    await dependencies.stage_events.start_effects(transition_ids);
    outcomes.push(outcome);
  }
  return outcomes;
};
