import { expect, spyOn, test } from "bun:test";
import { selectMcpServers } from "./client";

test("every session receives the configured HTTP endpoint with trailing slashes removed", () => {
  expect(selectMcpServers("http://example.test/mcp///")).toEqual([
    { type: "http", name: "gated-review", url: "http://example.test/mcp", headers: [] },
  ]);
});

test("an unset endpoint returns no servers and logs unavailability", () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(selectMcpServers(undefined)).toEqual([]);
    expect(warning).toHaveBeenCalledWith("[acp] gated-review unavailable: OAKRIDGE_GATED_REVIEW_URL is unset");
  } finally { warning.mockRestore(); }
});
