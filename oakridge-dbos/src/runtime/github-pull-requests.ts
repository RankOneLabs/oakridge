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
import type { StageInstanceId, UnitId } from "../domain/primitives";
import type { OperatorCohortSummary } from "../domain/operator-projections";
import { findCohortPullRequestExpectation, reconcileCohortEvidence, type CohortPullRequestDependencies, type CohortPullRequestResolution } from "./cohort-pull-request";

/** Reads one pull request's current state. Absent when it cannot be read. */
export interface PullRequestReader {
  read(owner: string, name: string, number: number): Promise<PullRequestObservation | null>;
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

  async read(owner: string, name: string, number: number): Promise<PullRequestObservation | null> {
    const response = await this.http(`${this.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.config.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": this.config.user_agent ?? "oakridge",
      },
    });
    if (!response.ok) return null;
    const payload = await response.json() as GithubPullRequestPayload;
    const url = asString(payload.html_url);
    const headBranch = asString(payload.head?.ref);
    const baseBranch = asString(payload.base?.ref);
    if (!url || !headBranch || !baseBranch || typeof payload.number !== "number") return null;
    const mergedAt = asString(payload.merged_at);
    const merged = payload.merged === true || mergedAt !== null;
    return {
      provider: "github", owner, name, number: payload.number, url,
      head_branch: headBranch, base_branch: baseBranch, head_sha: asString(payload.head?.sha),
      state: merged ? "merged" : payload.state === "closed" ? "closed_unmerged" : "open",
      source: "poll", observed_at: new Date().toISOString(), merged_at: mergedAt,
    };
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
  cohorts.filter((cohort) => cohort.lifecycle === "github_review");

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
    const observation = await dependencies.reader.read(identity.owner, identity.name, identity.number).catch(() => null);
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
