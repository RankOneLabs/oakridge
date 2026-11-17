import { emptyCounters, object, rawUsage, type UsageCounters, type UsageParser, type ModelUsage } from "#kbbl/core/acp/usage-parsers/types";

/** codex-acp 1.13.0 real two-turn fixture: counters reset each prompt. */
function counters(value: unknown, quota: boolean): UsageCounters | null {
  if (!object(value)) return null;
  const cached = quota ? "cachedInputTokens" : "cachedReadTokens";
  const thought = quota ? "reasoningOutputTokens" : "thoughtTokens";
  if (!["inputTokens", "outputTokens", cached, thought, "totalTokens"].every(
    key => typeof value[key] === "number" && Number.isSafeInteger(value[key]) && Number(value[key]) >= 0,
  )) return null;
  return {
    input_tokens: Number(value.inputTokens), output_tokens: Number(value.outputTokens),
    cached_read_tokens: Number(value[cached]), thought_tokens: Number(value[thought]),
    total_tokens: Number(value.totalTokens), cached_write_tokens: null,
  };
}

export const codexUsageParser: UsageParser = {
  turn(usage, meta) {
    const quota = object(meta) ? meta.quota : undefined;
    if (usage == null && quota == null) return { status: "absent" };
    const parsed = counters(usage, false);
    const quotaCounts = object(quota) ? counters(quota.token_count, true) : null;
    const rows = object(quota) ? quota.model_usage : undefined;
    const models: ModelUsage[] = [];
    const recognised = Array.isArray(rows) && rows.length > 0 && rows.every(row => {
      if (!object(row) || typeof row.model !== "string") return false;
      const counts = counters(row.token_count, true);
      if (!counts) return false;
      const { total_tokens, ...rest } = counts;
      models.push({ model: row.model, ...rest });
      return true;
    });
    return {
      status: parsed && quotaCounts && recognised ? "reported" : "partial",
      ...(parsed ?? emptyCounters), model_usage: recognised ? models : null,
      raw_json: rawUsage(usage, meta),
    };
  },
  origin() { return { autonomous: false, origin_kind: null }; },
};
