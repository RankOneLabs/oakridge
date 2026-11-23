/**
 * Pull requests as GitHub reports them, read-only: the `pull_request.observe`
 * operation reads one by number. A backend without a token has no reader, and
 * the operation fails rather than guess.
 */
import type { ObservedPullRequestState } from "../domain/pull-request";
import { err, ok, type Result } from "../domain/primitives";

export interface PullRequestReadOptions { readonly signal?: AbortSignal }
/** One pull request of a repository, by its number. */
export interface PullRequestRef { readonly owner: string; readonly name: string; readonly number: number }
/**
 * One pull request as the forge reports it now: its state, and the head and
 * base it was opened between. `head_owner` is null when the head repository
 * is gone (a deleted fork).
 */
export interface ForgePullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: ObservedPullRequestState;
  readonly head_owner: string | null;
  readonly head_branch: string;
  readonly base_branch: string;
  readonly head_sha: string | null;
  readonly merged_at: string | null;
}
/** Reads one pull request by number; null when the forge has no such pull request. */
export interface PullRequestReader {
  get(ref: PullRequestRef, options?: PullRequestReadOptions): Promise<Result<ForgePullRequest | null, PullRequestReadError>>;
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

export interface GithubPullRequestPayload {
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
/**
 * GitHub answers a primary or a secondary rate limit with 403 (or 429): an
 * exhausted `x-ratelimit-remaining`, or a `retry-after`. That is transient,
 * not a credential the token lacks.
 */
export function isRateLimited(status: number, headers: Headers): boolean {
  return (status === 403 || status === 429) && (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after"));
}
export function selectStatusError(response: Pick<Response, "status" | "headers">, detail: string): PullRequestReadError {
  const { status } = response;
  const kind = isRateLimited(status, response.headers) ? "unavailable"
    : status === 401 || status === 403 ? "auth"
    : status === 408 || status === 409 || status === 429 || status >= 500 ? "unavailable" : "rejected";
  return { kind, status, detail };
}

/**
 * One pull request as GitHub's pull request endpoint reports it. Null when a
 * field the observation needs is missing. It carries no read time, so an
 * unchanged pull request is an unchanged observation and publishes nothing.
 *
 * `merged` is trusted over `state` — a merged pull request reports
 * `state: "closed"`, and reading only the state would file every merge as a
 * close without merge.
 */
export function selectPullRequest(payload: GithubPullRequestPayload): ForgePullRequest | null {
  const url = asString(payload.html_url);
  const head_branch = asString(payload.head?.ref);
  const base_branch = asString(payload.base?.ref);
  if (!url || !head_branch || !base_branch || typeof payload.number !== "number") return null;
  const merged_at = asString(payload.merged_at);
  const is_merged = payload.merged === true || merged_at !== null;
  return { number: payload.number, url, head_owner: repositoryOwner(payload.head?.repo?.full_name), head_branch, base_branch,
    head_sha: asString(payload.head?.sha), state: is_merged ? "merged" : payload.state === "closed" ? "closed_unmerged" : "open", merged_at };
}

/** GitHub's REST API, read-only. */
export class GithubPullRequestReader implements PullRequestReader {
  private readonly apiBaseUrl: string;
  constructor(private readonly config: GithubPullRequestReaderConfig, private readonly http: typeof fetch = fetch) {
    this.apiBaseUrl = (config.api_base_url ?? "https://api.github.com").replace(/\/+$/, "");
  }

  /** `GET /repos/{owner}/{name}/pulls/{number}`; a 404 is no such pull request. */
  async get(ref: PullRequestRef, options: PullRequestReadOptions = {}): Promise<Result<ForgePullRequest | null, PullRequestReadError>> {
    const url = `${this.apiBaseUrl}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/pulls/${ref.number}`;
    let response: Response;
    try { response = await this.http(url, { signal: options.signal, headers: { accept: "application/vnd.github+json",
      authorization: `Bearer ${this.config.token}`, "x-github-api-version": "2022-11-28", "user-agent": this.config.user_agent ?? "oakridge" } }); }
    catch (cause) { return err({ kind: "unavailable", status: null, detail: String(cause) }); }
    if (response.status === 404) return ok(null);
    if (!response.ok) return err(selectStatusError(response, `could not read pull request ${ref.owner}/${ref.name}#${ref.number}`));
    let payload: unknown;
    try { payload = await response.json(); }
    catch (cause) { return err({ kind: "unavailable", status: response.status, detail: String(cause) }); }
    const pull_request = typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? selectPullRequest(payload as GithubPullRequestPayload) : null;
    if (!pull_request) return err({ kind: "unavailable", status: response.status, detail: `pull request ${ref.number} is missing fields` });
    return ok(pull_request);
  }
}
