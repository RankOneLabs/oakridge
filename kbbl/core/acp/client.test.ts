import { describe, expect, test } from "bun:test";
import { selectGatedReviewAccess, selectMcpServers } from "./client";

const identity = (worker: string, gated_review?: { kind: "restricted"; role: "builder" | "assessor" } | { kind: "unscoped" }) =>
  ({ run_id: "run-1", unit_id: "run-1/implementation/a", worker, gated_review });

const server = (url: string) => [{ type: "http" as const, name: "gated-review", url, headers: [] }];

describe("definition-driven gated-review access", () => {
  test("a renamed worker keeps its declared role endpoint", () => {
    const access = selectGatedReviewAccess(identity("renamed-worker", { kind: "restricted", role: "assessor" }));
    expect(selectMcpServers("http://otto:3555/mcp/", access)).toEqual(server("http://otto:3555/mcp/assessor"));
  });

  test("a worker named builder without a grant receives no endpoint", () => {
    expect(selectMcpServers("http://otto:3555/mcp", selectGatedReviewAccess(identity("builder")))).toEqual([]);
  });

  test("a hand-started session receives no endpoint", () => {
    expect(selectMcpServers("http://otto:3555/mcp", selectGatedReviewAccess(null))).toEqual([]);
  });

  test("an invalid role receives no endpoint", () => {
    const malformed = { ...identity("builder"), gated_review: { kind: "restricted", role: "administrator" } };
    expect(selectMcpServers("http://otto:3555/mcp", selectGatedReviewAccess(malformed as never))).toEqual([]);
  });

  test("explicit unscoped access receives the base endpoint", () => {
    expect(selectMcpServers("http://otto:3555/mcp/", selectGatedReviewAccess(identity("integrator", { kind: "unscoped" }))))
      .toEqual(server("http://otto:3555/mcp"));
  });

  test("no configured server means no endpoint", () => {
    expect(selectMcpServers(undefined, { kind: "restricted", role: "builder" })).toEqual([]);
  });
});
