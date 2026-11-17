import { emptyCounters, object, rawUsage, type UsageCounters, type UsageParser, type ModelUsage } from "./types";
function counters(value: unknown, model: boolean): UsageCounters | null {
  if (!object(value)) return null;
  const fields = ["inputTokens", "outputTokens", model ? "cachedInputTokens" : "cachedReadTokens", "cachedWriteTokens", "totalTokens"];
  if (!fields.every(key => typeof value[key] === "number" && Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)) return null;
  return {
    input_tokens: Number(value.inputTokens), output_tokens: Number(value.outputTokens),
    cached_read_tokens: Number(value[fields[2] as string]), cached_write_tokens: Number(value.cachedWriteTokens),
    total_tokens: Number(value.totalTokens), thought_tokens: 0,
  };
}
export const claudeUsageParser: UsageParser = {
  turn(usage, meta) {
    const quota = object(meta) ? meta.quota : undefined;
    const rows = object(quota) ? quota.model_usage : undefined;
    if (usage == null && quota == null) return { status: "absent" };
    const parsed = counters(usage, false);
    const models: ModelUsage[] = [];
    const recognised = Array.isArray(rows) && rows.every(row => {
      if (!object(row) || typeof row.model !== "string") return false;
      const counts = counters(row.token_count, true);
      if (!counts) return false;
      const { total_tokens, ...rest } = counts;
      models.push({ model: row.model, ...rest });
      return true;
    });
    return {
      status: parsed && recognised ? "reported" : "partial",
      ...(parsed ?? emptyCounters), model_usage: recognised ? models : null,
      raw_json: rawUsage(usage, meta),
    };
  },
  origin(meta) {
    const origin = object(meta) ? meta["_claude/origin"] : null;
    const kind = object(origin) && typeof origin.kind === "string" ? origin.kind : null;
    return { origin_kind: kind, autonomous: kind !== null && ["task-notification", "peer", "coordinator", "observer"].includes(kind) };
  },
};
