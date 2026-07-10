// Model list helpers. Populated from the cached model/list result at startup
// and augmented with pinned Codex models kbbl routes to directly.

export interface CodexModel {
  value: string;
  label: string;
}

const PINNED_CODEX_MODELS: CodexModel[] = [
  { value: "gpt-5.6-sol", label: "gpt-5.6 sol" },
  { value: "gpt-5.6-terra", label: "gpt-5.6 terra" },
  { value: "gpt-5.6-luna", label: "gpt-5.6 luna" },
  { value: "gpt-5.5", label: "gpt-5.5" },
  { value: "gpt-5.4", label: "gpt-5.4" },
  { value: "gpt-5.4-mini", label: "gpt-5.4 mini" },
  { value: "gpt-5.3-codex-spark", label: "gpt-5.3 codex spark" },
];

/**
 * Codex reasoning-effort levels (the app-server `ReasoningEffort` enum), passed
 * per-turn via `turn/start`'s `effort` field. Ordered least→most effort.
 * Surfaced in the Codex RuntimeDescriptor.efforts; a session with no effort
 * selected omits the field entirely and runs at Codex's configured default.
 */
export const CODEX_EFFORTS: readonly { value: string; label: string }[] = [
  { value: "minimal", label: "minimal" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

/**
 * Normalize the raw result from model/list into CodexModel entries.
 * Accepts null or any non-array value and returns the pinned Codex models.
 */
export function normalizeModelList(raw: unknown): CodexModel[] {
  const dynamicModels = Array.isArray(raw)
    ? raw
      .filter((m): m is { id: string } => typeof m?.id === "string")
      .map((m) => ({ value: m.id, label: m.id }))
    : [];
  const byValue = new Map<string, CodexModel>();
  for (const model of [...dynamicModels, ...PINNED_CODEX_MODELS]) {
    if (!byValue.has(model.value)) byValue.set(model.value, model);
  }
  return [...byValue.values()];
}
