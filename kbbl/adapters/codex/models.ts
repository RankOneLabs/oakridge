// Model list helpers. Populated from the cached model/list result at startup
// and augmented with pinned Codex models kbbl routes to directly.

export interface CodexModel {
  value: string;
  label: string;
}

const PINNED_CODEX_MODELS: CodexModel[] = [
  { value: "gpt-5.5", label: "gpt-5.5" },
  { value: "gpt-5.4-mini", label: "gpt-5.4 mini" },
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
