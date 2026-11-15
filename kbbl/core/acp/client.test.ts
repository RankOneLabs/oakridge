import { expect, test } from "bun:test";
import { selectMcpServers } from "./client";
test("gated-review receives exactly the configured HTTP server", () => {
  expect(selectMcpServers("gated-review", "http://review/mcp/")).toEqual({ ok: true, value: [{ type: "http", name: "gated-review", url: "http://review/mcp/", headers: [] }] });
});
test("github-cli and none receive no MCP servers", () => {
  for (const integration of ["github-cli", "none"] as const) expect(selectMcpServers(integration, "http://review/mcp")).toEqual({ ok: true, value: [] });
});
test("missing gated-review configuration is a typed preflight error", () => {
  const result = selectMcpServers("gated-review", null);
  expect(result.ok ? null : result.error.code).toBe("pr_integration_unconfigured");
});
