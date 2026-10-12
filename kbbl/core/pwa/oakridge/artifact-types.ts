/**
 * v2 artifact bodies are plain JSON rather than a schema-directed value tree,
 * so a field is read by key and needs no pinned schema to locate it.
 */
const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function selectBodyField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] ?? null : null;
}

export function selectText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

export const selectItems = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

export const selectFieldText = (value: unknown, key: string): string | null =>
  selectText(selectBodyField(value, key));

export const selectFieldItems = (value: unknown, key: string): readonly unknown[] =>
  selectItems(selectBodyField(value, key));

export const selectHttpUrl = (value: string | null): string | null =>
  value !== null && /^https?:\/\//i.test(value) ? value : null;
