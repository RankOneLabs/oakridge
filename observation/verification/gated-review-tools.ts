/**
 * Proves what the configured gated-review endpoint advertises to agents.
 *
 *   OAKRIDGE_GATED_REVIEW_URL=<url> bun observation/verification/gated-review-tools.ts \
 *     [--run-id <id>] [--unit-id <id>] [--report <path>]
 *
 * The endpoint is the one every agent session receives: selectMcpServers takes
 * it unchanged, with no credential and no client-side tool filter. This client
 * negotiates a real MCP session, follows every tools/list page and only reads:
 * no tool is called, so the human-only tools are never probed by execution.
 */
import { rename } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { selectMcpServers } from "../../kbbl/core/acp/client";
import { err, ok, type Result } from "../src/domain/primitives";

/** Tools gated-review reserves for humans; their absence from the agent list is the proof. */
export const HUMAN_ONLY_TOOLS: readonly string[] = ["merge_pr", "mark_merge_ready"];
/** The agent catalogue every session must reach, whatever its worker. */
export const AGENT_TOOLS: readonly string[] = [
  "review.get_state", "review.list_actions", "open_pr", "set_pr_draft", "reply_to_thread", "resolve_thread",
  "request_next_round", "git.push", "git.pull", "git.fetch", "get_review_round", "pr_status", "get_workflow_status",
];
const REQUESTED_PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 10_000;

const rpcMessage = z.looseObject({ jsonrpc: z.literal("2.0"), id: z.number().nullish(), result: z.unknown().optional(),
  error: z.looseObject({ code: z.number(), message: z.string() }).optional() });
const initializeResult = z.looseObject({ protocolVersion: z.string(),
  serverInfo: z.looseObject({ name: z.string(), version: z.string() }) });
const toolsListResult = z.looseObject({ tools: z.array(z.looseObject({ name: z.string() })), nextCursor: z.string().nullish() });

type RpcMessage = z.infer<typeof rpcMessage>;
export type EndpointFailureKind = "endpoint_unset" | "endpoint_unreachable" | "protocol_failure" | "incomplete_list";
export interface EndpointFailure { readonly kind: EndpointFailureKind; readonly operation: string; readonly detail: string }
/** One tools/list response as the server sent it, with the cursor that requested it. */
export interface ToolsListPage { readonly cursor: string | null; readonly result: unknown }
export interface ToolsListing { readonly initialize_result: unknown; readonly pages: readonly ToolsListPage[]; readonly tool_names: readonly string[] }
export interface ReportAssertion { readonly name: string; readonly passed: boolean; readonly detail: string }
export interface RunContext { readonly run_id: string | null; readonly unit_id: string | null }
export type ReportStatus = "passed" | "failed" | "incomplete";
export interface GatedReviewToolsReport {
  readonly checked_at: string;
  readonly endpoint: string | null;
  readonly run: RunContext;
  /** `incomplete` has no complete list to judge; `failed` has one that breaks an assertion. */
  readonly status: ReportStatus;
  readonly failure: EndpointFailure | null;
  readonly initialize_result: unknown;
  readonly pages: readonly ToolsListPage[];
  readonly tool_names: readonly string[];
  readonly assertions: readonly ReportAssertion[];
}
export interface ToolsCheckRequest {
  readonly endpoint: string | undefined;
  readonly run: RunContext;
  readonly http: typeof fetch;
  readonly now: () => Date;
}

class ProtocolFailure extends Error {
  constructor(readonly failure: EndpointFailure) { super(failure.detail); }
}
const protocolFailure = (kind: EndpointFailureKind, operation: string, detail: string): ProtocolFailure =>
  new ProtocolFailure({ kind, operation, detail });

/** Every JSON-RPC message in a response body, plain JSON or a server-sent event stream. */
export function selectRpcMessages(body: string, content_type: string | null): readonly RpcMessage[] {
  const payloads = content_type?.includes("text/event-stream")
    ? body.split(/\r?\n\r?\n/).map((event) => event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()).join("\n")).filter((data) => data !== "")
    : [body];
  return payloads.map((payload) => rpcMessage.parse(JSON.parse(payload)));
}

/** The endpoint as it may be retained: any embedded credential or query never reaches the report. */
export function selectReportEndpoint(endpoint: string | undefined): string | null {
  if (!endpoint || !URL.canParse(endpoint)) return null;
  const parsed = new URL(endpoint);
  return parsed.username || parsed.password || parsed.search ? `${parsed.origin}${parsed.pathname}` : endpoint;
}

/** The checked claims, judged only against a complete advertised list. */
export function selectAssertions(endpoint: string, tool_names: readonly string[]): readonly ReportAssertion[] {
  const present = HUMAN_ONLY_TOOLS.filter((name) => tool_names.includes(name));
  const missing = AGENT_TOOLS.filter((name) => !tool_names.includes(name));
  const servers = selectMcpServers(endpoint);
  const is_unfiltered = servers.length === 1 && servers.every((server) =>
    "url" in server && server.url === endpoint && server.headers.length === 0);
  return [
    { name: "human_only_tools_absent", passed: present.length === 0,
      detail: present.length === 0 ? `absent: ${HUMAN_ONLY_TOOLS.join(", ")}` : `advertised: ${present.join(", ")}` },
    { name: "agent_catalogue_available", passed: missing.length === 0,
      detail: missing.length === 0 ? `${AGENT_TOOLS.length} agent tools advertised` : `missing: ${missing.join(", ")}` },
    { name: "sessions_receive_this_endpoint_unfiltered", passed: is_unfiltered,
      detail: "selectMcpServers supplies the configured URL unchanged, with no header" },
  ];
}

async function listTools(endpoint: string, http: typeof fetch): Promise<ToolsListing> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const send = (method: "POST" | "DELETE", body?: unknown): Promise<Response> => http(endpoint, { method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const post = async (operation: string, body: unknown): Promise<Response> => {
    let response: Response;
    try { response = await send("POST", body); } catch (cause) {
      throw protocolFailure("endpoint_unreachable", operation, String(cause));
    }
    if (!response.ok) throw protocolFailure("protocol_failure", operation, `HTTP ${response.status}: ${await response.text()}`);
    return response;
  };
  const request = async (id: number, method: string, params: unknown): Promise<{ readonly response: Response; readonly result: unknown }> => {
    const response = await post(method, { jsonrpc: "2.0", id, method, params });
    let messages: readonly RpcMessage[];
    try { messages = selectRpcMessages(await response.text(), response.headers.get("content-type")); } catch (cause) {
      throw protocolFailure("protocol_failure", method, `unreadable response: ${String(cause)}`);
    }
    const message = messages.find((candidate) => candidate.id === id);
    if (!message) throw protocolFailure("protocol_failure", method, `no response to request ${id}`);
    if (message.error) throw protocolFailure("protocol_failure", method, `${message.error.code}: ${message.error.message}`);
    return { response, result: message.result };
  };
  const initialized = await request(1, "initialize", { protocolVersion: REQUESTED_PROTOCOL_VERSION, capabilities: {},
    clientInfo: { name: "oakridge-gated-review-tools", version: "1" } });
  const negotiated = initializeResult.safeParse(initialized.result);
  if (!negotiated.success) throw protocolFailure("protocol_failure", "initialize", negotiated.error.message);
  headers["mcp-protocol-version"] = negotiated.data.protocolVersion;
  const session_id = initialized.response.headers.get("mcp-session-id");
  if (session_id) headers["mcp-session-id"] = session_id;
  try {
    await (await post("notifications/initialized", { jsonrpc: "2.0", method: "notifications/initialized" })).body?.cancel();
    const pages: ToolsListPage[] = [];
    const tool_names: string[] = [];
    const seen_cursors = new Set<string>();
    let cursor: string | null = null;
    // A loop: each request depends on the cursor the previous page returned.
    for (;;) {
      const { result } = await request(pages.length + 2, "tools/list", cursor === null ? {} : { cursor });
      const page = toolsListResult.safeParse(result);
      if (!page.success) throw protocolFailure("incomplete_list", "tools/list", page.error.message);
      pages.push({ cursor, result });
      tool_names.push(...page.data.tools.map((tool) => tool.name));
      const next: string | null = page.data.nextCursor ?? null;
      if (next === null) break;
      if (seen_cursors.has(next)) throw protocolFailure("incomplete_list", "tools/list", `cursor ${next} repeated`);
      seen_cursors.add(next);
      cursor = next;
    }
    return { initialize_result: initialized.result, pages, tool_names: [...new Set(tool_names)].sort() };
  } finally {
    if (session_id) {
      try { await (await send("DELETE")).body?.cancel(); }
      catch { /* A failed cleanup does not change what the server advertised. */ }
    }
  }
}

async function listConfiguredTools(endpoint: string | undefined, http: typeof fetch): Promise<Result<ToolsListing, EndpointFailure>> {
  if (!endpoint) return err({ kind: "endpoint_unset", operation: "configuration", detail: "OAKRIDGE_GATED_REVIEW_URL is unset" });
  try {
    return ok(await listTools(endpoint, http));
  } catch (cause) {
    if (cause instanceof ProtocolFailure) return err(cause.failure);
    throw cause;
  }
}

export async function checkGatedReviewTools(request: ToolsCheckRequest): Promise<GatedReviewToolsReport> {
  const context = { checked_at: request.now().toISOString(), endpoint: selectReportEndpoint(request.endpoint), run: request.run };
  const listed = await listConfiguredTools(request.endpoint, request.http);
  if (!listed.ok) return { ...context, status: "incomplete", failure: listed.error, initialize_result: null, pages: [], tool_names: [], assertions: [] };
  const assertions = selectAssertions(request.endpoint!, listed.value.tool_names);
  return { ...context, status: assertions.every((assertion) => assertion.passed) ? "passed" : "failed", failure: null, ...listed.value, assertions };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const argument = (name: string): string | null => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1] ?? null; };
  const report_path = resolve(argument("--report") ?? resolve(import.meta.dir, "gated-review-tools.json"));
  const report = await checkGatedReviewTools({ endpoint: process.env.OAKRIDGE_GATED_REVIEW_URL, http: fetch, now: () => new Date(),
    run: { run_id: argument("--run-id"), unit_id: argument("--unit-id") } });
  await Bun.write(`${report_path}.pending`, JSON.stringify(report, null, 2) + "\n");
  await rename(`${report_path}.pending`, report_path);
  console.info(`${report.status}: ${report.tool_names.length} tools from ${report.endpoint ?? "no endpoint"}; report ${report_path}`);
  if (report.status !== "passed") process.exit(1);
}
