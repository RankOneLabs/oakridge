import { describe, expect, test } from "bun:test";
import { selectMcpServers } from "./client";

const server = (url: string) => [{ type: "http" as const, name: "gated-review", url, headers: [] }];

describe("the configured gated-review endpoint", () => {
  test("is supplied without a role suffix or credential header", () => {
    expect(selectMcpServers("http://otto:3555/mcp")).toEqual(server("http://otto:3555/mcp"));
  });

  test("keeps its configured path and trailing slash", () => {
    expect(selectMcpServers("http://review.test:9000/custom/path/")).toEqual(server("http://review.test:9000/custom/path/"));
  });

  test("an unset endpoint supplies no server", () => {
    expect(selectMcpServers(undefined)).toEqual([]);
  });

  test("an empty endpoint supplies no server", () => {
    expect(selectMcpServers("")).toEqual([]);
  });
});
