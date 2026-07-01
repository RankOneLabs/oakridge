export const PWA_MODEL_OPTIONS = [
  { value: "claude-sonnet-5", label: "sonnet 5" },
  { value: "claude-sonnet-4-6", label: "sonnet 4.6" },
  { value: "claude-opus-4-8", label: "opus 4.8" },
  { value: "claude-opus-4-7", label: "opus 4.7" },
  { value: "claude-haiku-4-5-20251001", label: "haiku 4.5" },
  { value: "", label: "default" },
] as const;

export function prettyModelLabel(model: string): string {
  return PWA_MODEL_OPTIONS.find((o) => o.value === model)?.label ?? model;
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n} tokens`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k tokens`;
  return `${(n / 1_000_000).toFixed(1)}M tokens`;
}

export function fmtTokensCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtDuration(ms: number): string {
  if (!ms) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  // Round to total seconds first, then split — splitting independently lets
  // the seconds round up to 60 and produce strings like "1m60s".
  const totalSec = Math.round(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m${secs.toString().padStart(2, "0")}s`;
}

export function fmtCost(cost: number): string {
  if (cost <= 0) return "$0.00";
  if (cost < 0.01) return "<$0.01";
  if (cost < 0.9995) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}
