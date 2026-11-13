/** A presentation tree for arbitrary captured JSON, independent of React. */
export type StructuredNode =
  | { kind: "text"; text: string }
  | { kind: "list"; items: StructuredNode[] }
  | { kind: "section"; fields: StructuredField[] };
export interface StructuredField { label: string; node: StructuredNode }

export function humaniseKey(key: string): string {
  const words = key.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\s]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Accepts typed domain objects as well as the generic JSON wire value. */
export function toStructuredNode(value: unknown): StructuredNode {
  if (value === null) return { kind: "text", text: "None" };
  if (value === undefined) return { kind: "text", text: "Not recorded" };
  if (Array.isArray(value)) return { kind: "list", items: value.map(toStructuredNode) };
  if (typeof value === "object") return { kind: "section", fields: Object.entries(value).map(([key, entry]) => ({ label: humaniseKey(key), node: toStructuredNode(entry) })) };
  return { kind: "text", text: String(value) };
}

/** JSON pointer paths are addresses, including escaped keys and the root's empty pointer. */
export interface StructuredPathNode {
  readonly item_path: string;
  readonly label: string;
  readonly value: unknown;
  readonly children: readonly StructuredPathNode[];
}
export function selectStructuredPaths(value: unknown, item_path = "", label = "Body"): StructuredPathNode {
  const entries = value !== null && typeof value === "object" ? Object.entries(value) : [];
  return { item_path, label, value, children: entries.map(([key, child]) =>
    selectStructuredPaths(child, `${item_path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, key)) };
}
