import { describe, expect, test } from "bun:test";
import { selectGatedReviewRole, selectMcpServers } from "./client";

const identity = (worker: string) => ({ run_id: "run-1", unit_id: "run-1/implementation/a", worker });

describe("selectGatedReviewRole", () => {
  test("scopes the cohort builder and assessor", () => {
    expect([selectGatedReviewRole(identity("builder")), selectGatedReviewRole(identity("assessor"))]).toEqual(["builder", "assessor"]);
  });

  test("leaves the integrator and other workers unscoped", () => {
    expect([selectGatedReviewRole(identity("integrator")), selectGatedReviewRole(identity("writer"))]).toEqual([null, null]);
  });

  test("leaves a hand-started session unscoped", () => {
    expect(selectGatedReviewRole(null)).toBeNull();
  });
});

describe("selectMcpServers", () => {
  test("serves a role from its endpoint under the base URL", () => {
    expect(selectMcpServers("http://otto:3555/mcp/", "builder"))
      .toEqual([{ type: "http", name: "gated-review", url: "http://otto:3555/mcp/builder", headers: [] }]);
  });

  test("serves an unscoped session from the base URL", () => {
    expect(selectMcpServers("http://otto:3555/mcp", null))
      .toEqual([{ type: "http", name: "gated-review", url: "http://otto:3555/mcp", headers: [] }]);
  });

  test("supplies no server when none is configured", () => {
    expect(selectMcpServers(undefined, "assessor")).toEqual([]);
  });
});
