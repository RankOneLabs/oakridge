/** Capture contract derived from ACP Usage and Claude quota token_count. */
export interface UsageCounters {
  input_tokens: number | null;
  output_tokens: number | null;
  cached_read_tokens: number | null;
  cached_write_tokens: number | null;
  thought_tokens: number | null;
  total_tokens: number | null;
}
export interface ModelUsage extends Omit<UsageCounters, "total_tokens"> { model: string }
export type TurnUsage = { status: "absent" } | ({
  status: "reported" | "partial";
  model_usage: ModelUsage[] | null;
  raw_json: string;
} & UsageCounters);
export interface ReadingOrigin { autonomous: boolean; origin_kind: string | null }
export interface UsageParser {
  turn(usage: unknown, meta: unknown): TurnUsage;
  origin(meta: unknown): ReadingOrigin;
}
export const emptyCounters: UsageCounters = {
  input_tokens: null, output_tokens: null, cached_read_tokens: null,
  cached_write_tokens: null, thought_tokens: null, total_tokens: null,
};
export function object(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function rawUsage(usage: unknown, meta: unknown): string {
  return JSON.stringify({ usage: usage ?? null, quota: object(meta) ? meta.quota ?? null : null });
}
export function parseTurn(parser: UsageParser | undefined, usage: unknown, meta: unknown): TurnUsage {
  if (!parser) return { status: "absent" };
  try { return parser.turn(usage, meta); }
  catch { return { status: "partial", ...emptyCounters, model_usage: null, raw_json: rawUsage(usage, meta) }; }
}
