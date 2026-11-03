/** Live MCP grant verification; opt in with `bun run test:acp:gated-review:real`.
 * Base endpoint: GATED_REVIEW_MCP_URL = "http://otto:3555/mcp".
 * Prerequisites: GATED_REVIEW_BUILDER_TOKEN and GATED_REVIEW_ASSESSOR_TOKEN,
 * distinct bearer credentials issued by the server for those roles. No UI tool
 * catalogue is consulted. Expectations pin gated-review's role-grant contract
 * (src/tools/agent-roles.ts), independently of Oakridge's curated skill rail.
 */
import { expect, test } from "bun:test";
import { z } from "zod";
import { selectGatedReviewAccess, selectMcpServers } from "./client";

const base_url = "http://otto:3555/mcp";
const builder_token = process.env.GATED_REVIEW_BUILDER_TOKEN;
const assessor_token = process.env.GATED_REVIEW_ASSESSOR_TOKEN;
const missing = [
  ...(!builder_token ? ["GATED_REVIEW_BUILDER_TOKEN"] : []),
  ...(!assessor_token ? ["GATED_REVIEW_ASSESSOR_TOKEN"] : []),
];
// Probe transport availability only. HTTP/auth/protocol failures on a reachable
// server belong to the test, rather than being disguised as missing prerequisites.
if (missing.length === 0) {
  try {
    const response = await fetch(base_url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
  } catch {
    missing.push(`reachable gated-review MCP server at ${base_url}`);
  }
}
const liveTest = missing.length === 0 ? test : test.skip;
if (missing.length) console.warn(`SKIP: gated-review live tools/list; missing ${missing.join(", ")}`);

const rpcResponse = z.object({ jsonrpc: z.literal("2.0"), id: z.number(),
  result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).optional() });
const toolList = z.object({ tools: z.array(z.object({ name: z.string() })), nextCursor: z.string().optional() });

async function message(response: Response): Promise<z.infer<typeof rpcResponse>> {
  const body = await response.text();
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
    : body;
  return rpcResponse.parse(JSON.parse(data));
}

interface RoleGrant { readonly role: "builder" | "assessor"; readonly token: string;
  readonly expected_tools: readonly string[] }
async function verifyGrant(grant: RoleGrant): Promise<void> {
  const [endpoint] = selectMcpServers(base_url, { kind: "restricted", role: grant.role });
  if (!endpoint || !("url" in endpoint)) throw new Error(`no HTTP endpoint for ${grant.role}`);
  const headers: Record<string, string> = { authorization: `Bearer ${grant.token}`,
    "content-type": "application/json", accept: "application/json, text/event-stream" };
  const post = (body: unknown, request_headers = headers) => fetch(endpoint.url, { method: "POST", headers: request_headers,
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const initialized = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "oakridge-grant-smoke", version: "1" } } });
  expect(initialized.status).toBe(200);
  const init = await message(initialized);
  expect(init.error).toBeUndefined();
  const protocol = z.object({ protocolVersion: z.string() }).parse(init.result);
  headers["mcp-protocol-version"] = protocol.protocolVersion;
  const session = initialized.headers.get("mcp-session-id");
  if (session) headers["mcp-session-id"] = session;
  try {
    const notification = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notification.status).toBe(202);
    await notification.body?.cancel();
    const response = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(response.status).toBe(200);
    const listed = await message(response);
    expect(listed.error).toBeUndefined();
    const result = toolList.parse(listed.result);
    expect(result.nextCursor).toBeUndefined();
    const tool_names = result.tools.map((tool) => tool.name).sort();
    console.info(JSON.stringify({ role: grant.role, tool_names }));
    expect(tool_names).toEqual([...grant.expected_tools].sort());
  } finally {
    if (session) {
      const closed = await fetch(endpoint.url, { method: "DELETE", headers, signal: AbortSignal.timeout(3000) });
      await closed.body?.cancel();
    }
  }
}

liveTest("declared roles receive exactly their live grants", async () => {
  if (!builder_token || !assessor_token) throw new Error("live credentials disappeared");
  expect(builder_token === assessor_token).toBe(false);
  await verifyGrant({ role: "builder", token: builder_token, expected_tools: [
    "review.get_state", "review.list_actions", "open_pr", "reply_to_thread", "resolve_thread",
    "request_next_round", "git.push", "git.pull", "git.fetch", "get_review_round", "pr_status",
  ] });
  await verifyGrant({ role: "assessor", token: assessor_token, expected_tools: [
    "review.get_state", "review.list_actions", "set_pr_draft", "git.fetch", "get_review_round", "pr_status",
  ] });
  const identity = { run_id: "live-grant", unit_id: "live-grant/unit", worker: "builder" };
  expect(selectMcpServers(base_url, selectGatedReviewAccess(identity))).toEqual([]);
  const malformed = { ...identity, gated_review: { kind: "restricted", role: "administrator" } };
  // The boundary can receive malformed persisted data, outside the declared union.
  expect(selectMcpServers(base_url, selectGatedReviewAccess(malformed as never))).toEqual([]);
}, 60_000);
