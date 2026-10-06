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

export interface PullRequestReadOptions { readonly signal?: AbortSignal }
export interface PullRequestBranchQuery { readonly owner: string; readonly name: string; readonly head_owner: string; readonly head_branch: string; readonly base_branch: string }
/** Reads one pull request's current state. Absent when it cannot be read. */
export interface PullRequestReader {
  find_for_branches?(query: PullRequestBranchQuery, options?: PullRequestReadOptions): Promise<Result<readonly PullRequestObservation[], PullRequestReadError>>;
  read(owner: string, name: string, number: number, options?: PullRequestReadOptions): Promise<Result<PullRequestObservation | null, PullRequestReadError>>;
}

export interface PullRequestReadError {
  readonly kind: "unavailable" | "auth" | "rejected";
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
  readonly head?: { readonly ref?: unknown; readonly sha?: unknown; readonly repo?: { readonly full_name?: unknown } | null } | null;
  readonly base?: { readonly ref?: unknown } | null;
}

const asString = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
/** The owner half of a `owner/name` repository slug; a fork may be renamed, so only the owner is compared. */
const repositoryOwner = (full_name: unknown): string | null => asString(full_name)?.split("/")[0] ?? null;
const sameOwner = (left: string | null, right: string): boolean => left !== null && left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
const statusError = (status: number, detail: string): PullRequestReadError => ({
  kind: status === 401 || status === 403 ? "auth" : status === 408 || status === 409 || status === 429 || status >= 500 ? "unavailable" : "rejected",
  status, detail,
});

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

  async find_for_branches(query: PullRequestBranchQuery, options: PullRequestReadOptions = {}): Promise<Result<readonly PullRequestObservation[], PullRequestReadError>> {
    const url = new URL(`${this.apiBaseUrl}/repos/${encodeURIComponent(query.owner)}/${encodeURIComponent(query.name)}/pulls`);
    url.searchParams.set("state", "all");
    url.searchParams.set("head", `${query.head_owner}:${query.head_branch}`);
    url.searchParams.set("base", query.base_branch);
    url.searchParams.set("per_page", "100");
    const observations: PullRequestObservation[] = [];
    for (let page = 1; page <= 100; page++) {
      url.searchParams.set("page", String(page));
      let response: Response;
      try { response = await this.http(url.toString(), { signal: options.signal, headers: { accept: "application/vnd.github+json",
        authorization: `Bearer ${this.config.token}`, "x-github-api-version": "2022-11-28", "user-agent": this.config.user_agent ?? "oakridge" } }); }
      catch (cause) { return err({ kind: "unavailable", status: null, detail: String(cause) }); }
      if (!response.ok) return err(statusError(response.status, "could not discover an existing final pull request"));
      let candidates: readonly GithubPullRequestPayload[];
      try { const body: unknown = await response.json();
        if (!Array.isArray(body)) return err({ kind: "unavailable", status: response.status, detail: "pull request collection is invalid" });
        candidates = body as readonly GithubPullRequestPayload[];
      } catch (cause) { return err({ kind: "unavailable", status: response.status, detail: String(cause) }); }
      for (const candidate of candidates) {
        if (typeof candidate.number !== "number") return err({ kind: "unavailable", status: response.status, detail: "pull request candidate has no number" });
        if (!sameOwner(repositoryOwner(candidate.head?.repo?.full_name), query.head_owner)
          || candidate.head?.ref !== query.head_branch || candidate.base?.ref !== query.base_branch) continue;
        const observed = await this.read(query.owner, query.name, candidate.number, options);
        if (!observed.ok) return observed;
        if (observed.value?.head_branch === query.head_branch && observed.value.base_branch === query.base_branch) observations.push(observed.value);
      }
      if (candidates.length < 100 && !response.headers.get("link")?.includes('rel="next"')) return ok(observations);
    }
    return err({ kind: "unavailable", status: null, detail: "pull request discovery exceeded 100 pages" });
  }

  async read(owner: string, name: string, number: number, options: PullRequestReadOptions = {}): Promise<Result<PullRequestObservation | null, PullRequestReadError>> {
    let response: Response;
    try { response = await this.http(`${this.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`, {
      signal: options.signal,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.config.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": this.config.user_agent ?? "oakridge",
      },
    }); } catch (error) { return err({ kind: "unavailable", status: null, detail: String(error) }); }
    if (response.status === 404) return ok(null);
    if (!response.ok) return err(statusError(response.status, `GitHub pull request read failed (${response.status})`));
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
