// Model list helpers. In v0, populated from the cached model/list result at startup.
// Returns an empty array if model/list fails (non-fatal — operator sees no model dropdown).

export interface CodexModel {
  value: string;
  label: string;
}

/**
 * Normalize the raw result from model/list into CodexModel entries.
 * Accepts null or any non-array value and returns an empty array (non-fatal).
 */
export function normalizeModelList(raw: unknown): CodexModel[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is { id: string } => typeof m?.id === "string")
    .map((m) => ({ value: m.id, label: m.id }));
}
