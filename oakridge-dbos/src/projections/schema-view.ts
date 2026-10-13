import type { ReviewDecision, TypeExpression, Workflow } from "../core-client/core-types";

/**
 * The PWA's schema contract (v1 `Schema`): every type a workflow declares,
 * flattened into named shapes that reference each other by key. The PWA never
 * parses a type expression (rescue spec §2.4); this module is where v2
 * `TypeExpression`s become these shapes.
 */
export interface Schema { readonly key: string; readonly shape: SchemaShape }
/**
 * `required` is always true: the core requires every record field to be
 * present, and an `optional(T)` field admits null, not absence.
 */
export interface SchemaField { readonly key: string; readonly required: boolean; readonly schema: string }
export type SchemaShape =
  | { readonly kind: "boolean" }
  | { readonly kind: "integer"; readonly min: number; readonly max: number }
  | { readonly kind: "string"; readonly min_length: number; readonly max_length: number }
  | { readonly kind: "enum"; readonly variants: readonly string[] }
  | { readonly kind: "record"; readonly fields: readonly SchemaField[] }
  | { readonly kind: "list"; readonly item: string; readonly max_items: number }
  | { readonly kind: "optional"; readonly item: string };

/** One parsed type expression; an alias stays a reference to its named schema. */
export type TypeNode =
  | { readonly kind: "primitive"; readonly name: PrimitiveName }
  | { readonly kind: "alias"; readonly name: string }
  | { readonly kind: "list"; readonly item: TypeNode }
  | { readonly kind: "optional"; readonly item: TypeNode }
  | { readonly kind: "enum"; readonly variants: readonly string[] }
  | { readonly kind: "record"; readonly fields: readonly (readonly [string, TypeNode])[] };
type PrimitiveName = "text" | "ident" | "repo_path" | "integer" | "boolean";
const PRIMITIVES: readonly string[] = ["text", "ident", "repo_path", "integer", "boolean"];
const isPrimitive = (name: string): name is PrimitiveName => PRIMITIVES.includes(name);

/** The core's ident bound (`MAX_IDENT_CHARS`); text, lists and integers are bounded only by the wire. */
const MAX_IDENT_CHARS = 100;
const WIRE_MAX = Number.MAX_SAFE_INTEGER;

/** Split at commas outside braces and parentheses, as the core's `split_top_level` does. */
function splitTopLevel(text: string): readonly string[] {
  const pieces: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (ch === "{" || ch === "(") depth++;
    else if (ch === "}" || ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) { pieces.push(text.slice(start, index).trim()); start = index + 1; }
  }
  pieces.push(text.slice(start).trim());
  return pieces;
}
const inner = (text: string, name: string): string | null =>
  text.startsWith(`${name}(`) && text.endsWith(")") ? text.slice(name.length + 1, -1) : null;

/** Parse one type expression in the core's grammar. The workflow compiled, so the text is well formed. */
export function parseType(type: TypeExpression): TypeNode {
  if (typeof type !== "string")
    return { kind: "record", fields: Object.keys(type).sort().map((key) => [key, parseType(type[key] as TypeExpression)] as const) };
  const text = type.trim();
  if (text.startsWith("{") && text.endsWith("}")) {
    const body = text.slice(1, -1).trim();
    const fields = body === "" ? [] : splitTopLevel(body).map((field) => {
      const colon = field.indexOf(":");
      return [field.slice(0, colon).trim(), parseType(field.slice(colon + 1))] as const;
    });
    return { kind: "record", fields: [...fields].sort(([left], [right]) => left.localeCompare(right)) };
  }
  const list = inner(text, "list");
  if (list !== null) return { kind: "list", item: parseType(list) };
  const optional = inner(text, "optional");
  if (optional !== null) return { kind: "optional", item: parseType(optional) };
  const variants = inner(text, "enum");
  if (variants !== null) return { kind: "enum", variants: splitTopLevel(variants) };
  return isPrimitive(text) ? { kind: "primitive", name: text } : { kind: "alias", name: text };
}

/** A node's schema key: an alias keeps its name, anything else is its canonical text. */
export function schemaKey(node: TypeNode): string {
  switch (node.kind) {
    case "primitive": case "alias": return node.name;
    case "list": return `list(${schemaKey(node.item)})`;
    case "optional": return `optional(${schemaKey(node.item)})`;
    case "enum": return `enum(${node.variants.join(", ")})`;
    case "record": return `{${node.fields.map(([key, field]) => `${key}: ${schemaKey(field)}`).join(", ")}}`;
  }
}
export const typeSchemaKey = (type: TypeExpression): string => schemaKey(parseType(type));

function primitiveShape(name: PrimitiveName): SchemaShape {
  switch (name) {
    case "boolean": return { kind: "boolean" };
    case "integer": return { kind: "integer", min: -WIRE_MAX, max: WIRE_MAX };
    case "ident": return { kind: "string", min_length: 1, max_length: MAX_IDENT_CHARS };
    case "text": case "repo_path": return { kind: "string", min_length: 0, max_length: WIRE_MAX };
  }
}

/** Every schema a node needs, its own first; an alias contributes only its name (its body is emitted once, under that name). */
function nodeSchemas(node: TypeNode): readonly Schema[] {
  switch (node.kind) {
    case "alias": return [];
    case "primitive": return [{ key: node.name, shape: primitiveShape(node.name) }];
    case "enum": return [{ key: schemaKey(node), shape: { kind: "enum", variants: node.variants } }];
    case "list": return [{ key: schemaKey(node), shape: { kind: "list", item: schemaKey(node.item), max_items: WIRE_MAX } }, ...nodeSchemas(node.item)];
    case "optional": return [{ key: schemaKey(node), shape: { kind: "optional", item: schemaKey(node.item) } }, ...nodeSchemas(node.item)];
    case "record": return [{ key: schemaKey(node), shape: { kind: "record", fields: node.fields.map(([key, field]) =>
      ({ key, required: true, schema: schemaKey(field) })) } }, ...node.fields.flatMap(([, field]) => nodeSchemas(field))];
  }
}
type Aliases = { readonly [name: string]: TypeExpression };
/** A named schema: the alias's own key, with the shape of the type it names (through any chain of aliases). */
function aliasSchemas(name: string, aliases: Aliases): readonly Schema[] {
  let body = parseType(aliases[name] as TypeExpression);
  const visited = new Set([name]);
  while (body.kind === "alias" && !visited.has(body.name) && aliases[body.name] !== undefined) {
    visited.add(body.name);
    body = parseType(aliases[body.name] as TypeExpression);
  }
  const [own, ...rest] = nodeSchemas(body);
  return own ? [{ key: name, shape: own.shape }, ...rest] : rest;
}

/**
 * A review decision's payload type. `payload` is what the core checks; `fields`
 * name text fields to collect, and a `request_changes` decision must carry
 * `feedback` (the core refuses one without it).
 */
export function selectDecisionPayloadType(decision: ReviewDecision): TypeNode {
  const declared = decision.payload == null ? null : parseType(decision.payload);
  const fields = new Map<string, TypeNode>(declared?.kind === "record" ? declared.fields : []);
  for (const key of Object.keys(decision.fields ?? {})) if (!fields.has(key)) fields.set(key, { kind: "primitive", name: "text" });
  if (decision.effect === "request_changes" && !fields.has("feedback")) fields.set("feedback", { kind: "primitive", name: "text" });
  if (declared && declared.kind !== "record") return declared;
  return { kind: "record", fields: [...fields].sort(([left], [right]) => left.localeCompare(right)) };
}
/** Retry and cancel carry no payload. */
export const EMPTY_PAYLOAD: TypeNode = { kind: "record", fields: [] };

/**
 * Every schema a workflow's operator surface references: its named schemas,
 * the run and stage inputs, artifact bodies and review decision payloads. Keys
 * are unique; the first emission of a key wins (they are equal by construction).
 */
export function selectWorkflowSchemas(workflow: Workflow): readonly Schema[] {
  const nodes: TypeNode[] = [parseType(workflow.input), EMPTY_PAYLOAD];
  for (const stage of Object.values(workflow.stages)) {
    nodes.push(parseType(stage.input));
    for (const artifact of Object.values(stage.artifacts)) nodes.push(parseType(artifact.schema));
    for (const review of Object.values(stage.reviews ?? {}))
      for (const decision of Object.values(review.decisions)) nodes.push(selectDecisionPayloadType(decision));
  }
  const aliases = workflow.schemas ?? {};
  const all = [...Object.keys(aliases).flatMap((name) => aliasSchemas(name, aliases)), ...nodes.flatMap(nodeSchemas)];
  const seen = new Set<string>();
  return all.filter((schema) => !seen.has(schema.key) && !!seen.add(schema.key));
}
