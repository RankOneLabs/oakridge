import { expect, test } from "bun:test";
import { AGENT_TOOLS, checkGatedReviewTools, selectReportEndpoint, selectRpcMessages, type GatedReviewToolsReport } from "../verification/gated-review-tools";

// These mocks establish parsing and selection only. The endpoint proof is the
// report produced against the real configured server.
const endpoint = "http://review.test/mcp/";
const now = () => new Date("2026-11-06T00:00:00.000Z");
const run = { run_id: "run-1", unit_id: "run-1/unit" };
interface RecordedCall { readonly url: string; readonly method: string; readonly headers: Headers; readonly rpc_method: string | null; readonly cursor: string | null }
interface MockServer { readonly http: typeof fetch; readonly calls: RecordedCall[] }
type ListReply = (cursor: string | null, id: number) => Response;

const json = (value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } });
const page = (id: number, names: readonly string[], nextCursor?: string) =>
  json({ jsonrpc: "2.0", id, result: { tools: names.map((name) => ({ name, inputSchema: { type: "object" } })), ...(nextCursor ? { nextCursor } : {}) } });

function mockServer(reply: ListReply): MockServer {
  const calls: RecordedCall[] = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { id: number; method: string; params?: { cursor?: string } } : null;
    calls.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), rpc_method: body?.method ?? null, cursor: body?.params?.cursor ?? null });
    if (body?.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: {},
      serverInfo: { name: "gated-review", version: "0.1.0" } } }, { "mcp-session-id": "session-1" });
    if (body?.method === "tools/list") return reply(body.params?.cursor ?? null, body.id);
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  return { http, calls };
}
const check = (server: MockServer, url: string | undefined = endpoint): Promise<GatedReviewToolsReport> =>
  checkGatedReviewTools({ endpoint: url, run, http: server.http, now });
const failedAssertions = (report: GatedReviewToolsReport) => report.assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.name);

test("a complete catalogue without human-only tools passes", async () => {
  const report = await check(mockServer((_, id) => page(id, AGENT_TOOLS)));
  expect({ status: report.status, tools: report.tool_names, failed: failedAssertions(report) })
    .toEqual({ status: "passed", tools: [...AGENT_TOOLS].sort(), failed: [] });
});

test("every continuation page is followed and retained", async () => {
  const server = mockServer((cursor, id) => cursor === null ? page(id, AGENT_TOOLS.slice(0, 5), "next") : page(id, AGENT_TOOLS.slice(5)));
  const report = await check(server);
  expect({ status: report.status, cursors: report.pages.map((listed) => listed.cursor) }).toEqual({ status: "passed", cursors: [null, "next"] });
});

test("a human-only tool on a later page fails the proof", async () => {
  const report = await check(mockServer((cursor, id) => cursor === null ? page(id, AGENT_TOOLS, "next") : page(id, ["merge_pr"])));
  expect({ status: report.status, failed: failedAssertions(report) }).toEqual({ status: "failed", failed: ["human_only_tools_absent"] });
});

test("mark_merge_ready fails the proof", async () => {
  const report = await check(mockServer((_, id) => page(id, [...AGENT_TOOLS, "mark_merge_ready"])));
  expect(report.status).toBe("failed");
});

test("an empty list fails the proof", async () => {
  const report = await check(mockServer((_, id) => page(id, [])));
  expect({ status: report.status, failed: failedAssertions(report) }).toEqual({ status: "failed", failed: ["agent_catalogue_available"] });
});

test("an unset endpoint is incomplete and makes no request", async () => {
  const server = mockServer((_, id) => page(id, AGENT_TOOLS));
  const report = await checkGatedReviewTools({ endpoint: undefined, run, http: server.http, now });
  expect({ status: report.status, kind: report.failure?.kind, calls: server.calls.length }).toEqual({ status: "incomplete", kind: "endpoint_unset", calls: 0 });
});

test("an unreachable endpoint is incomplete", async () => {
  const http = (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;
  const report = await checkGatedReviewTools({ endpoint, run, http, now });
  expect({ status: report.status, kind: report.failure?.kind }).toEqual({ status: "incomplete", kind: "endpoint_unreachable" });
});

test("a JSON-RPC error is incomplete", async () => {
  const report = await check(mockServer((_, id) => json({ jsonrpc: "2.0", id, error: { code: -32601, message: "no such method" } })));
  expect({ status: report.status, kind: report.failure?.kind }).toEqual({ status: "incomplete", kind: "protocol_failure" });
});

test("a repeated cursor is incomplete rather than a truncated pass", async () => {
  const report = await check(mockServer((_, id) => page(id, AGENT_TOOLS, "again")));
  expect({ status: report.status, kind: report.failure?.kind }).toEqual({ status: "incomplete", kind: "incomplete_list" });
});

test("a malformed list is incomplete", async () => {
  const report = await check(mockServer((_, id) => json({ jsonrpc: "2.0", id, result: { tools: "none" } })));
  expect({ status: report.status, kind: report.failure?.kind }).toEqual({ status: "incomplete", kind: "incomplete_list" });
});

test("requests use the exact configured URL with no credential", async () => {
  const server = mockServer((_, id) => page(id, AGENT_TOOLS));
  await check(server);
  expect({ urls: [...new Set(server.calls.map((call) => call.url))], authorized: server.calls.some((call) => call.headers.has("authorization")) })
    .toEqual({ urls: [endpoint], authorized: false });
});

test("the negotiated session and protocol reach every later request, which closes the session", async () => {
  const server = mockServer((_, id) => page(id, AGENT_TOOLS));
  await check(server);
  const later = server.calls.slice(1);
  expect({ sessions: later.map((call) => call.headers.get("mcp-session-id")), versions: [...new Set(later.map((call) => call.headers.get("mcp-protocol-version")))],
    closed: later.at(-1)?.method }).toEqual({ sessions: later.map(() => "session-1"), versions: ["2025-03-26"], closed: "DELETE" });
});

test("no tool is ever called", async () => {
  const server = mockServer((_, id) => page(id, AGENT_TOOLS));
  await check(server);
  expect(server.calls.map((call) => call.rpc_method)).toEqual(["initialize", "notifications/initialized", "tools/list", null]);
});

test("event-stream responses yield each JSON-RPC message", () => {
  const body = 'event: message\ndata: {"jsonrpc":"2.0","method":"ping"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{}}\n\n';
  expect(selectRpcMessages(body, "text/event-stream").map((message) => message.id ?? null)).toEqual([null, 2]);
});

test("the report keeps a plain endpoint exactly and strips an embedded credential", () => {
  expect([selectReportEndpoint("http://otto:3555/mcp/"), selectReportEndpoint("http://user:secret@otto:3555/mcp?token=x"), selectReportEndpoint(undefined)])
    .toEqual(["http://otto:3555/mcp/", "http://otto:3555/mcp", null]);
});
