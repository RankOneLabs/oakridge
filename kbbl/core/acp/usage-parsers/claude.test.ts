import { expect, test } from "bun:test";
import { claudeUsageParser as parser } from "#kbbl/core/acp/usage-parsers/claude";
import { parseTurn } from "#kbbl/core/acp/usage-parsers/types";
export const usage = { inputTokens: 10, outputTokens: 5, cachedReadTokens: 4, cachedWriteTokens: 3, totalTokens: 22 };
export const meta = { quota: { token_count: {}, model_usage: [{ model: "claude", token_count: {
  inputTokens: 12, outputTokens: 6, cachedInputTokens: 5, cachedWriteTokens: 4, totalTokens: 27,
} }] } };
test("recognised Claude sources preserve raw values and accounting includes main-loop usage", () => {
  const parsed = parser.turn(usage, meta);
  expect(parsed.status).toBe("reported");
  if (parsed.status === "absent") throw Error("missing");
  expect(parsed.thought_tokens).toBe(0);
  expect(JSON.parse(parsed.raw_json)).toEqual({ usage, quota: meta.quota });
  for (const key of ["input_tokens", "output_tokens", "cached_read_tokens", "cached_write_tokens"] as const)
    expect(parsed.model_usage?.reduce((sum, row) => sum + (row[key] ?? 0), 0)).toBeGreaterThanOrEqual(parsed[key] ?? 0);
});
test("missing and malformed sources are partial; neither source is absent", () => {
  for (const [u, m] of [[usage, null], [null, meta], [{ strange: true }, { quota: "unexpected" }]])
    expect(parser.turn(u, m).status).toBe("partial");
  expect(parser.turn(null, null)).toEqual({ status: "absent" });
  expect(parseTurn(undefined, usage, meta)).toEqual({ status: "absent" });
  expect(parseTurn({ ...parser, turn() { throw Error("parser failed"); } }, usage, meta).status).toBe("partial");
});
test("Claude origin only classifies the four autonomous kinds", () => {
  for (const kind of ["task-notification", "peer", "coordinator", "observer", "human", "channel", "auto-continuation", "new-kind"]) {
    expect(parser.origin({ "_claude/origin": { kind } })).toEqual({
      origin_kind: kind, autonomous: ["task-notification", "peer", "coordinator", "observer"].includes(kind),
    });
  }
  expect(parser.origin(null)).toEqual({ origin_kind: null, autonomous: false });
});
