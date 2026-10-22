import { expect, test } from "bun:test";
import { GatedReviewPullRequestReader } from "../src/runtime/gated-review-pull-requests";

const status = { pullRequestNumber: 118, state: "OPEN", url: "https://github.com/acme/site/pull/118",
  headOwner: "acme", headBranch: "research-tip", headSha: "abc123", baseBranch: "main", mergedAt: null,
  openThreadCount: 0, mergeReady: { isReady: false, source: "github_label", label: "merge-ready" },
  checks: { state: "passing", totalCount: 0, failingCount: 0, pendingCount: 0, contexts: [] } };
const ref = { owner: "acme", name: "site", number: 118 };

function mockMcp(result: unknown) {
  const calls: { method: string; body: unknown; session: string | null }[] = [];
  const http = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
    const session = new Headers(init?.headers).get("mcp-session-id");
    calls.push({ method: init?.method ?? "GET", body, session });
    if (calls.length === 1) return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } },
      { headers: { "mcp-session-id": "session-1" } });
    if (calls.length === 2) return new Response(null, { status: 202 });
    if (calls.length === 3) return Response.json({ jsonrpc: "2.0", id: 2, result });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return { reader: new GatedReviewPullRequestReader("http://gated-review.test/mcp", http), calls };
}

test("reads a pull request through pr_status and closes the MCP session", async () => {
  const { reader, calls } = mockMcp({ structuredContent: status });
  const result = await reader.get(ref);
  expect(result).toEqual({ ok: true, value: { number: 118, url: status.url, head_owner: "acme", head_branch: "research-tip",
    head_sha: "abc123", base_branch: "main", state: "open", merged_at: null } });
  expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "POST", "DELETE"]);
  expect(calls[2]?.session).toBe("session-1");
  expect(calls[2]?.body).toEqual({ jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "pr_status", arguments: { repository: "acme/site", pullRequestNumber: 118 } } });
});

test("maps a merged PR with a deleted fork owner", async () => {
  const { reader } = mockMcp({ structuredContent: { ...status, state: "MERGED", headOwner: null, mergedAt: "2026-10-19T10:00:00Z" } });
  const result = await reader.get(ref);
  expect(result.ok && result.value).toMatchObject({ state: "merged", head_owner: null, merged_at: "2026-10-19T10:00:00Z" });
});

test("rejects a mismatched PR number from the tool", async () => {
  const { reader } = mockMcp({ structuredContent: { ...status, pullRequestNumber: 119 } });
  const result = await reader.get(ref);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.kind).toBe("unavailable");
});

test("retries a tool read failure instead of ending the watch", async () => {
  const { reader } = mockMcp({ isError: true, content: [{ type: "text", text: "GitHub request failed" }] });
  const result = await reader.get(ref);
  expect(result).toEqual({ ok: false, error: { kind: "unavailable", status: null, detail: "GitHub request failed" } });
});
