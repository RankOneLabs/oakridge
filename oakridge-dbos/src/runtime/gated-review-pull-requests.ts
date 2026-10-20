import { err, ok, type Result } from "../domain/primitives";
import type { ForgePullRequest, PullRequestReadError, PullRequestReadOptions, PullRequestReader, PullRequestRef } from "./github-pull-requests";

interface McpResponse {
  readonly result?: {
    readonly isError?: boolean;
    readonly structuredContent?: unknown;
    readonly content?: readonly { readonly type?: unknown; readonly text?: unknown }[];
  };
  readonly error?: { readonly message?: unknown };
}

/** The added `pr_status` fields, derived from gated-review's output schema. */
interface GatedReviewPrStatus {
  readonly pullRequestNumber: number;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly url: string;
  readonly headOwner: string | null;
  readonly headBranch: string;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly mergedAt: string | null;
}

const protocolVersion = "2025-06-18";
const isFields = (value: unknown): value is { readonly [key: string]: unknown } =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function decodePrStatus(value: unknown): GatedReviewPrStatus | null {
  if (!isFields(value) || !Number.isSafeInteger(value.pullRequestNumber) || (value.pullRequestNumber as number) <= 0
    || (value.state !== "OPEN" && value.state !== "CLOSED" && value.state !== "MERGED")
    || !nonEmpty(value.url) || !(value.headOwner === null || nonEmpty(value.headOwner))
    || !nonEmpty(value.headBranch) || !nonEmpty(value.headSha) || !nonEmpty(value.baseBranch)
    || !(value.mergedAt === null || nonEmpty(value.mergedAt))) return null;
  return value as unknown as GatedReviewPrStatus;
}

const failure = (kind: PullRequestReadError["kind"], detail: string, status: number | null = null): Result<never, PullRequestReadError> =>
  err({ kind, detail, status });
const httpFailure = (response: Response, detail: string): Result<never, PullRequestReadError> =>
  failure(response.status === 401 || response.status === 403 ? "auth"
    : response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500 ? "unavailable" : "rejected",
  detail, response.status);

function mcpErrorDetail(payload: McpResponse): string {
  const content = payload.result?.content?.find((item) => item.type === "text" && typeof item.text === "string");
  return typeof content?.text === "string" ? content.text
    : typeof payload.error?.message === "string" ? payload.error.message : "gated-review refused pr_status";
}

function selectPullRequest(status: GatedReviewPrStatus): ForgePullRequest {
  return { number: status.pullRequestNumber, url: status.url, head_owner: status.headOwner,
    head_branch: status.headBranch, head_sha: status.headSha, base_branch: status.baseBranch,
    state: status.state === "MERGED" ? "merged" : status.state === "CLOSED" ? "closed_unmerged" : "open",
    merged_at: status.mergedAt };
}

/** A read-only MCP client for gated-review's `pr_status` tool. */
export class GatedReviewPullRequestReader implements PullRequestReader {
  constructor(private readonly mcp_url: string, private readonly http: typeof fetch = fetch) {}

  private post(body: unknown, session_id: string | null, signal: AbortSignal | undefined): Promise<Response> {
    return this.http(this.mcp_url, { method: "POST", signal,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(session_id ? { "mcp-session-id": session_id, "mcp-protocol-version": protocolVersion } : {}) },
      body: JSON.stringify(body) });
  }

  async get(ref: PullRequestRef, options: PullRequestReadOptions = {}): Promise<Result<ForgePullRequest | null, PullRequestReadError>> {
    let session_id: string | null = null;
    try {
      const initialized = await this.post({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion, capabilities: {}, clientInfo: { name: "oakridge", version: "1" } } }, null, options.signal);
      if (!initialized.ok) return httpFailure(initialized, "gated-review initialization failed");
      session_id = initialized.headers.get("mcp-session-id");
      if (!session_id) return failure("unavailable", "gated-review initialization returned no session id");
      const ready = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, session_id, options.signal);
      if (!ready.ok) return httpFailure(ready, "gated-review session notification failed");
      const response = await this.post({ jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "pr_status", arguments: { repository: `${ref.owner}/${ref.name}`, pullRequestNumber: ref.number } } }, session_id, options.signal);
      if (!response.ok) return httpFailure(response, `gated-review could not read ${ref.owner}/${ref.name}#${ref.number}`);
      const payload = await response.json() as McpResponse;
      // The tool reports GitHub read failures as isError without a stable error category.
      // Retry them instead of ending a watch on a temporary forge failure.
      if (payload.error || payload.result?.isError) return failure("unavailable", mcpErrorDetail(payload));
      const status = decodePrStatus(payload.result?.structuredContent);
      if (!status || status.pullRequestNumber !== ref.number) return failure("unavailable", "gated-review returned an invalid pr_status result");
      return ok(selectPullRequest(status));
    } catch (cause) {
      return failure("unavailable", `gated-review request failed: ${String(cause)}`);
    } finally {
      if (session_id) {
        try { await this.http(this.mcp_url, { method: "DELETE", headers: { "mcp-session-id": session_id,
          "mcp-protocol-version": protocolVersion } }); }
        catch { /* A failed cleanup does not replace the observation result. */ }
      }
    }
  }
}
