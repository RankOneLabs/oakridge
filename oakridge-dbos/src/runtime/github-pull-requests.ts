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
import { err, ok, type Result } from "../domain/primitives";
import type { CohortId } from "../domain/primitives";
import type { StageEventApplier } from "../storage/apply-stage-event";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";

export interface PullRequestBranchQuery { readonly owner: string; readonly name: string; readonly head_branch: string; readonly base_branch: string }
/** Reads one pull request's current state. Absent when it cannot be read. */
export interface PullRequestReader {
  find_for_branches?(query: PullRequestBranchQuery): Promise<Result<readonly PullRequestObservation[], PullRequestReadError>>;
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

  async find_for_branches(query: PullRequestBranchQuery): Promise<Result<readonly PullRequestObservation[], PullRequestReadError>> {
    const url = new URL(`${this.apiBaseUrl}/repos/${encodeURIComponent(query.owner)}/${encodeURIComponent(query.name)}/pulls`);
    url.searchParams.set("state", "all");
    url.searchParams.set("head", `${query.owner}:${query.head_branch}`);
    url.searchParams.set("base", query.base_branch);
    url.searchParams.set("per_page", "100");
    let response: Response;
    try { response = await this.http(url.toString(), { headers: { accept: "application/vnd.github+json",
      authorization: `Bearer ${this.config.token}`, "x-github-api-version": "2022-11-28", "user-agent": this.config.user_agent ?? "oakridge" } }); }
    catch (cause) { return err({ kind: "unavailable", status: null, detail: String(cause) }); }
    if (!response.ok) return err({ kind: "unavailable", status: response.status, detail: "could not discover an existing final pull request" });
    let candidates: readonly GithubPullRequestPayload[];
    try { const body: unknown = await response.json();
      if (!Array.isArray(body)) return err({ kind: "unavailable", status: response.status, detail: "pull request collection is invalid" });
      candidates = body as readonly GithubPullRequestPayload[];
    } catch (cause) { return err({ kind: "unavailable", status: response.status, detail: String(cause) }); }
    if (candidates.length === 100 || response.headers.get("link")?.includes('rel="next"'))
      return err({ kind: "unavailable", status: response.status, detail: "pull request discovery is incomplete; refusing to create a duplicate" });
    const observations: PullRequestObservation[] = [];
    for (const candidate of candidates) {
      if (typeof candidate.number !== "number") return err({ kind: "unavailable", status: response.status, detail: "pull request candidate has no number" });
      const observed = await this.read(query.owner, query.name, candidate.number);
      if (!observed.ok) return observed;
      if (observed.value?.head_branch === query.head_branch && observed.value.base_branch === query.base_branch) observations.push(observed.value);
    }
    return ok(observations);
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

export interface StagePullRequestPollOutcome {
  readonly cohort_id: CohortId;
  readonly state: string;
  readonly kind: "unchanged" | "observed" | "unavailable";
}
export interface StagePullRequestPollDependencies {
  readonly sql: TransactionalSqlExecutor;
  readonly stage_events: Pick<StageEventApplier, "advance">;
}
/** Polling rechecks the same authoritative snapshot and tree as operator requests. */
export const pollStagePullRequests = async (dependencies: StagePullRequestPollDependencies,
  only_cohort_id: CohortId | null = null): Promise<readonly StagePullRequestPollOutcome[]> => {
  const rows = await dependencies.sql.query<{ readonly cohort_id: CohortId; readonly state: string }>(
    `SELECT cohort.id::text AS cohort_id,cohort.state FROM oakridge.cohort cohort
     JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
     JOIN oakridge.workflow_run run ON run.id=cohort.run_id
     WHERE run.status='active' AND stage.status='active'
       AND (stage.stage_key='implementation' AND cohort.current_verified_pull_request_id IS NOT NULL
         OR stage.stage_key='final_integration' AND EXISTS (SELECT 1 FROM oakridge.worker_output output
           WHERE output.cohort_id=cohort.id AND output.output_name='pr_summary'))
       AND ($1::uuid IS NULL OR cohort.id=$1) ORDER BY cohort.id`, [only_cohort_id]);
  const outcomes: StagePullRequestPollOutcome[] = [];
  for (const row of rows) {
    let advanced: Awaited<ReturnType<StageEventApplier["advance"]>>;
    try { advanced = await dependencies.stage_events.advance(row.cohort_id, null); }
    catch { outcomes.push({ ...row, kind: "unavailable" }); continue; }
    if (!advanced.ok) { outcomes.push({ ...row, kind: "unavailable" }); continue; }
    const latest = await dependencies.sql.query<{ readonly state: string }>("SELECT state FROM oakridge.cohort WHERE id=$1", [row.cohort_id]);
    outcomes.push({ cohort_id: row.cohort_id, state: latest[0]?.state ?? row.state,
      kind: advanced.value.commits > 0 ? "observed" : "unchanged" });
  }
  return outcomes;
};
