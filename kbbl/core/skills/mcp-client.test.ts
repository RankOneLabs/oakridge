import { describe, expect, test } from "bun:test";

import { invokeHttpMcpTool } from "./mcp-client";

describe("invokeHttpMcpTool", () => {
  test("performs the MCP handshake and sends a typed tools/call request", async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      const body = init?.body ? JSON.parse(String(init.body)) as { method?: string } : null;
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (body?.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "session-1",
            },
          },
        );
      }
      if (body?.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: "pushed" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const outcome = await invokeHttpMcpTool({
      url: "http://gated-review.test/mcp",
      fetchImpl,
      call: {
        serverName: "gated-review",
        toolName: "git.push",
        arguments: {
          repository: "RankOneLabs/oakridge",
          repo_path: "/repo/worktree",
          force_with_lease: false,
        },
      },
    });

    expect(outcome).toEqual({
      result: { content: [{ type: "text", text: "pushed" }] },
      isError: false,
    });
    const toolCall = requests
      .map((request) => request.body ? JSON.parse(String(request.body)) as { method?: string; params?: unknown } : null)
      .find((body) => body?.method === "tools/call");
    expect(toolCall?.params).toEqual({
      name: "git.push",
      arguments: {
        repository: "RankOneLabs/oakridge",
        repo_path: "/repo/worktree",
        force_with_lease: false,
      },
    });
  });
});
