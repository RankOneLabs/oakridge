import { expect, test } from "bun:test";
import fixtures from "#kbbl/core/acp/usage-parsers/__fixtures__/codex-acp-1.13.0/two-turns.json";
import { codexUsageParser as parser } from "#kbbl/core/acp/usage-parsers/codex";
import { builtinAgentProfiles } from "#kbbl/core/acp/default-profiles";
import { emptyCounters, rawUsage } from "#kbbl/core/acp/usage-parsers/types";
import { loadAgentProfiles } from "#kbbl/core/acp/agent-profile";
import { KbblConfigSchema } from "#kbbl/core/config";

test("real Codex two-turn counters map directly without cumulative double counting", () => {
  for (const fixture of fixtures) {
    expect(parser.turn(fixture.usage, fixture._meta)).toEqual({
      status: "reported", input_tokens: fixture.usage.inputTokens,
      output_tokens: fixture.usage.outputTokens, cached_read_tokens: fixture.usage.cachedReadTokens,
      thought_tokens: fixture.usage.thoughtTokens, total_tokens: fixture.usage.totalTokens,
      cached_write_tokens: null,
      model_usage: fixture._meta.quota.model_usage.map(row => ({
        model: row.model, input_tokens: row.token_count.inputTokens,
        output_tokens: row.token_count.outputTokens, cached_read_tokens: row.token_count.cachedInputTokens,
        thought_tokens: row.token_count.reasoningOutputTokens, cached_write_tokens: null,
      })), raw_json: JSON.stringify({ usage: fixture.usage, quota: fixture._meta.quota }),
    });
  }
});
test("missing expected sources and malformed shapes remain partial with raw payload", () => {
  const fixture = fixtures[0];
  if (!fixture) throw Error("missing fixture");
  for (const [usage, meta] of [[fixture.usage, null], [null, fixture._meta],
    [fixture.usage, { quota: { token_count: fixture._meta.quota.token_count } }],
    [{ bad: true }, { quota: "unknown" }]]) {
    const result = parser.turn(usage, meta);
    expect(result.status).toBe("partial");
    if (result.status !== "absent") expect(result.raw_json).toBe(rawUsage(usage, meta));
  }
  expect(parser.turn(null, null)).toEqual({ status: "absent" });
  expect(parser.turn({}, null)).toMatchObject(emptyCounters);
});
test("Codex profile selects parser and costless updates have no origin", () => {
  expect(builtinAgentProfiles("/unused").get("codex")?.usageParser).toBe(parser);
  expect(parser.origin(fixtures[0]?.usage_updates[0])).toEqual({ autonomous: false, origin_kind: null });
});
test("configured Codex profiles retain reported usage with and without builtins", () => {
  const config = KbblConfigSchema.parse({
    acp: { agents: { codex: { command: "custom-codex-acp" } } },
  });
  const fixture = fixtures[0];
  if (!fixture) throw Error("missing fixture");
  for (const builtins of [undefined, builtinAgentProfiles("/unused")]) {
    const profile = loadAgentProfiles(config.acp, builtins).get("codex");
    expect(profile?.command).toBe("custom-codex-acp");
    expect(profile?.usageParser).toBe(parser);
    expect(profile?.usageParser?.turn(fixture.usage, fixture._meta).status).toBe("reported");
  }
});
