import type { ParsedReviewDecision, ParsedWorkflow, Type } from "../core-client/core-types";

/**
 * The PWA's schema contract: every type a workflow declares,
 * flattened into named shapes that reference each other by key. The PWA never
 * parses a type expression (rescue spec §2.4); this module is where the core's
 * Tagged contract types become these shapes.
 */
export interface Schema { readonly key: string; readonly shape: SchemaShape }
/** A record field with `optional(T)` admits absence or null. */
export interface SchemaField { readonly key: string; readonly schema: string }
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

/** The core's ident bound (`MAX_IDENT_CHARS`); text, lists and integers are bounded only by the wire. */
const MAX_IDENT_CHARS = 100;
const WIRE_MAX = Number.MAX_SAFE_INTEGER;

/** Project the model's parsed type into the operator schema graph. */
export function typeNode(type: Type): TypeNode {
  switch (type.kind) {
    case "text": case "ident": case "repo_path": case "integer": case "boolean":
      return { kind: "primitive", name: type.kind };
    case "enum": return { kind: "enum", variants: type.variants };
    case "list": return { kind: "list", item: typeNode(type.item) };
    case "optional": return { kind: "optional", item: typeNode(type.value) };
    case "record": return { kind: "record", fields: Object.keys(type.fields).sort()
      .map((key) => [key, typeNode(type.fields[key] as Type)] as const) };
    case "named": return { kind: "alias", name: type.schema };
    case "outcome_of": throw new Error(`outcome_of(${type.stage}) must be resolved before projection`);
  }
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
export const typeSchemaKey = (type: Type): string => schemaKey(typeNode(type));

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
      ({ key, schema: schemaKey(field) })) } }, ...node.fields.flatMap(([, field]) => nodeSchemas(field))];
  }
}
type Aliases = { readonly [name: string]: Type };
export interface SchemaOrder { readonly schema_names: readonly string[]; readonly stage_names: readonly string[] }
/** A named schema: the alias's own key, with the shape of the type it names (through any chain of aliases). */
function aliasSchemas(name: string, aliases: Aliases): readonly Schema[] {
  let body = typeNode(aliases[name] as Type);
  const visited = new Set([name]);
  while (body.kind === "alias" && !visited.has(body.name) && aliases[body.name] !== undefined) {
    visited.add(body.name);
    body = typeNode(aliases[body.name] as Type);
  }
  const [own, ...rest] = nodeSchemas(body);
  return own ? [{ key: name, shape: own.shape }, ...rest] : rest;
}

/**
 * A review decision's payload type. `payload` is what the core checks; `fields`
 * name text fields to collect, and a `request_changes` decision must carry
 * `feedback` (the core refuses one without it).
 */
export function selectDecisionPayloadType(decision: ParsedReviewDecision): TypeNode {
  const declared = decision.payload == null ? null : typeNode(decision.payload);
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
export function selectWorkflowSchemas(workflow: ParsedWorkflow, order?: SchemaOrder): readonly Schema[] {
  const nodes: TypeNode[] = [typeNode(workflow.input), EMPTY_PAYLOAD];
  for (const stage_name of order?.stage_names ?? Object.keys(workflow.stages)) {
    const stage = workflow.stages[stage_name];
    if (!stage) continue;
    nodes.push(typeNode(stage.input));
    for (const artifact of Object.values(stage.artifacts)) nodes.push(typeNode(artifact.schema));
    for (const review of Object.values(stage.reviews ?? {}))
      for (const decision of Object.values(review.decisions)) nodes.push(selectDecisionPayloadType(decision));
  }
  const aliases = workflow.schemas ?? {};
  const all = [...(order?.schema_names ?? Object.keys(aliases)).flatMap((name) => aliasSchemas(name, aliases)), ...nodes.flatMap(nodeSchemas)];
  const seen = new Set<string>();
  return all.filter((schema) => !seen.has(schema.key) && !!seen.add(schema.key));
}
