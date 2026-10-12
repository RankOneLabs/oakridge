import type { OperatorTypeExpression } from "../operator-contracts";

/**
 * A v2 type expression is either a record — a plain object of named type
 * expressions — or a leaf written in the compiler's small DSL (`text`,
 * `optional(text)`, `list({...})`). v1's inspectable schema shapes are gone,
 * so the form layer reads structure from here instead.
 */
export type LeafKind = "text" | "integer" | "boolean" | "json";

export type ParsedType =
  | { readonly kind: "record"; readonly is_optional: boolean; readonly fields: readonly (readonly [string, OperatorTypeExpression])[] }
  | { readonly kind: "list"; readonly is_optional: boolean; readonly item: OperatorTypeExpression }
  | { readonly kind: "leaf"; readonly is_optional: boolean; readonly leaf: LeafKind };

/** `name(inner)` when the parentheses balance, otherwise null. */
function unwrap(text: string, name: string): string | null {
  const open = `${name}(`;
  if (!text.startsWith(open) || !text.endsWith(")")) return null;
  const inner = text.slice(open.length, -1);
  let depth = 0;
  for (const character of inner) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth < 0) return null;
  }
  return depth === 0 ? inner : null;
}

const INTEGER_LEAVES = new Set(["integer", "int", "number"]);
const BOOLEAN_LEAVES = new Set(["boolean", "flag", "bool"]);

export function parseTypeExpression(type: OperatorTypeExpression): ParsedType {
  if (typeof type !== "string")
    return { kind: "record", is_optional: false, fields: Object.entries(type) };
  const text = type.trim();
  const optional = unwrap(text, "optional");
  if (optional !== null) return { ...parseTypeExpression(optional), is_optional: true };
  const item = unwrap(text, "list");
  if (item !== null) return { kind: "list", is_optional: false, item };
  if (INTEGER_LEAVES.has(text)) return { kind: "leaf", is_optional: false, leaf: "integer" };
  if (BOOLEAN_LEAVES.has(text)) return { kind: "leaf", is_optional: false, leaf: "boolean" };
  // A braced leaf is an inline record the DSL did not expand; edit it as JSON.
  if (text.startsWith("{")) return { kind: "leaf", is_optional: false, leaf: "json" };
  return { kind: "leaf", is_optional: false, leaf: "text" };
}

export const isOptionalType = (type: OperatorTypeExpression): boolean => parseTypeExpression(type).is_optional;
