/** Opt in with test:acp:gated-review:real; offline suites register no live test. */
import { expect, test } from "bun:test";
import { z } from "zod";
import { selectMcpServers } from "./client";

interface GatedReviewToolRecording {
  readonly recorded_at: string;
  readonly endpoint: string;
  readonly tool_names: readonly string[];
}

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

if (process.env.KBBL_ACP_REAL_GATED_REVIEW === "1") {
  test("the configured endpoint exposes the agent tools and excludes human-only merge", async () => {
    const url = process.env.OAKRIDGE_GATED_REVIEW_URL;
    if (!url) throw new Error("OAKRIDGE_GATED_REVIEW_URL is required");
    const [endpoint] = selectMcpServers(url);
    if (!endpoint || !("url" in endpoint)) throw new Error("no HTTP endpoint");
    const headers: Record<string, string> = {
      "content-type": "application/json", accept: "application/json, text/event-stream",
    };
    const post = (body: unknown) => fetch(endpoint.url, { method: "POST", headers,
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const initialized = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "oakridge-tools-smoke", version: "1" },
    } });
    expect(initialized.status).toBe(200);
    const init = await message(initialized);
    expect(init.error).toBeUndefined();
    headers["mcp-protocol-version"] = z.object({ protocolVersion: z.string() }).parse(init.result).protocolVersion;
    const session = initialized.headers.get("mcp-session-id");
    if (session) headers["mcp-session-id"] = session;
    try {
      const notification = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      expect(notification.status).toBe(202);
      await notification.body?.cancel();
      const tool_names: string[] = [];
      let cursor: string | undefined;
      do {
        const response = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: cursor ? { cursor } : {} });
        expect(response.status).toBe(200);
        const listed = await message(response);
        expect(listed.error).toBeUndefined();
        const result = toolList.parse(listed.result);
        tool_names.push(...result.tools.map((tool) => tool.name));
        cursor = result.nextCursor;
      } while (cursor);
      tool_names.sort();
      expect(tool_names).not.toContain("merge_pr");
      expect(tool_names).not.toContain("mark_merge_ready");
      expect(tool_names).toEqual([
        "get_review_round", "get_workflow_status", "git.fetch", "git.pull", "git.push", "open_pr", "pr_status",
        "reply_to_thread", "request_next_round", "resolve_thread", "review.get_state", "review.list_actions", "set_pr_draft",
      ].sort());
      const recording: GatedReviewToolRecording = { recorded_at: new Date().toISOString(), endpoint: endpoint.url, tool_names };
      await Bun.write(new URL("../../../observation/verification/gated-review.json", import.meta.url), `${JSON.stringify(recording, null, 2)}\n`);
      console.info(JSON.stringify(recording));
    } finally {
      if (session) {
        const closed = await fetch(endpoint.url, { method: "DELETE", headers, signal: AbortSignal.timeout(3000) });
        await closed.body?.cancel();
      }
    }
  }, 60_000);
}
