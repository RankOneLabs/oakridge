// Generated from workflow-model::AuthoredWorkflow. Run scripts/generate-core-contracts.sh.
export const SOURCE_SCHEMA = {"$defs":{"Artifact":{"additionalProperties":false,"properties":{"edit_policy":{"$ref":"#/$defs/EditPolicy"},"schema":{"$ref":"#/$defs/Type"},"validate":{"default":[],"items":{"$ref":"#/$defs/ValidationCheck"},"type":"array"}},"required":["schema"],"type":"object"},"AuthoredDecisions":{"anyOf":[{"additionalProperties":{"$ref":"#/$defs/ReviewDecision"},"type":"object"},{"$ref":"#/$defs/DecisionSetUse"}]},"AuthoredReview":{"anyOf":[{"$ref":"#/$defs/AuthoredReviewDefinition"},{"$ref":"#/$defs/ReviewUse"}]},"AuthoredReviewDefinition":{"additionalProperties":false,"properties":{"by":{"$ref":"#/$defs/ReviewBy"},"decisions":{"$ref":"#/$defs/AuthoredDecisions"},"inputs":{"additionalProperties":{"type":"string"},"default":{},"type":"object"},"of":{"type":"string"},"prompt":{"type":["string","null"]},"when":{"type":["string","null"]}},"required":["of","by","decisions"],"type":"object"},"AuthoredStage":{"additionalProperties":false,"properties":{"artifacts":{"additionalProperties":{"$ref":"#/$defs/Artifact"},"type":"object"},"done_when":{"type":["string","null"]},"input":{"$ref":"#/$defs/Type"},"let":{"additionalProperties":{"type":"string"},"default":{},"type":"object"},"outcome":{"additionalProperties":{"type":"string"},"type":"object"},"reviews":{"additionalProperties":{"$ref":"#/$defs/AuthoredReview"},"default":{},"type":"object"},"workers":{"additionalProperties":{"$ref":"#/$defs/AuthoredWorker"},"type":"object"}},"required":["input","artifacts","workers","outcome"],"type":"object"},"AuthoredWorker":{"anyOf":[{"$ref":"#/$defs/Worker"},{"$ref":"#/$defs/WorkerUse"}]},"DecisionOverrides":{"additionalProperties":false,"properties":{"feedback":{"type":["string","null"]},"fields":{"additionalProperties":{"type":"string"},"type":["object","null"]},"label":{"type":["string","null"]},"on":{"type":["string","null"]},"payload":{"anyOf":[{"$ref":"#/$defs/Type"},{"type":"null"}]}},"type":"object"},"DecisionSetUse":{"additionalProperties":false,"properties":{"overrides":{"additionalProperties":{"$ref":"#/$defs/DecisionOverrides"},"default":{},"type":"object"},"rename":{"additionalProperties":{"type":"string"},"default":{},"type":"object"},"set":{"type":"string"}},"required":["set"],"type":"object"},"DeclaredDecisionEffect":{"enum":["approve","request_changes"],"type":"string"},"EditPolicy":{"oneOf":[{"additionalProperties":false,"properties":{"kind":{"const":"always","type":"string"}},"required":["kind"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"frozen_when_accepted","type":"string"}},"required":["kind"],"type":"object"}]},"GatedReviewAccess":{"oneOf":[{"additionalProperties":false,"properties":{"kind":{"const":"restricted","type":"string"},"role":{"$ref":"#/$defs/GatedReviewRole"}},"required":["kind","role"],"type":"object"},{"additionalProperties":false,"properties":{"kind":{"const":"unscoped","type":"string"}},"required":["kind"],"type":"object"}]},"GatedReviewRole":{"enum":["builder","assessor"],"type":"string"},"Group":{"additionalProperties":false,"properties":{"outcome":{"additionalProperties":{"type":"string"},"type":"object"},"pools":{"additionalProperties":{"maximum":4294967295,"minimum":0,"type":"integer"},"default":{},"type":"object"},"units":{"additionalProperties":{"$ref":"#/$defs/Unit"},"type":"object"}},"required":["units","outcome"],"type":"object"},"Prompts":{"additionalProperties":false,"properties":{"handoff":{"type":["string","null"]},"initial":{"type":["string","null"]},"review":{"type":["string","null"]},"revise":{"type":["string","null"]}},"type":"object"},"Review":{"additionalProperties":false,"properties":{"by":{"$ref":"#/$defs/ReviewBy"},"decisions":{"additionalProperties":{"$ref":"#/$defs/ReviewDecision"},"type":"object"},"inputs":{"additionalProperties":{"type":"string"},"default":{},"type":"object"},"of":{"type":"string"},"prompt":{"type":["string","null"]},"when":{"description":"Optional for an operator review: it awaits a decision only while this\nholds. Required for an engine review: the engine decides when it holds.","type":["string","null"]}},"required":["of","by","decisions"],"type":"object"},"ReviewBy":{"oneOf":[{"enum":["operator"],"type":"string"},{"const":"engine","description":"Decided by the engine, once per target revision, when `when` holds.","type":"string"}]},"ReviewDecision":{"additionalProperties":false,"properties":{"effect":{"$ref":"#/$defs/DeclaredDecisionEffect"},"feedback":{"description":"The fixed feedback an engine review's `request_changes` carries.","type":["string","null"]},"fields":{"additionalProperties":{"type":"string"},"default":{},"type":"object"},"label":{"type":"string"},"on":{"type":["string","null"]},"payload":{"anyOf":[{"$ref":"#/$defs/Type"},{"type":"null"}]}},"required":["effect","label"],"type":"object"},"ReviewOverrides":{"additionalProperties":false,"properties":{"decisions":{"additionalProperties":{"$ref":"#/$defs/DecisionOverrides"},"type":["object","null"]},"inputs":{"additionalProperties":{"type":"string"},"type":["object","null"]},"of":{"type":["string","null"]},"prompt":{"type":["string","null"]},"when":{"type":["string","null"]}},"type":"object"},"ReviewUse":{"additionalProperties":false,"properties":{"overrides":{"anyOf":[{"$ref":"#/$defs/ReviewOverrides"},{"type":"null"}],"default":null},"template":{"type":"string"}},"required":["template"],"type":"object"},"SessionMode":{"oneOf":[{"enum":["resume","fresh"],"type":"string"},{"const":"shared","description":"Resume one session across sibling units of a collection.","type":"string"}]},"Type":{"anyOf":[{"type":"string"},{"additionalProperties":{"$ref":"#/$defs/Type"},"type":"object"}]},"Unit":{"additionalProperties":false,"properties":{"after":{"$ref":"#/$defs/UnitDependencies","default":null},"for_each":{"type":["string","null"]},"group":{"anyOf":[{"$ref":"#/$defs/Group"},{"type":"null"}]},"input":{"additionalProperties":{"type":"string"},"default":{},"type":"object"},"key":{"type":["string","null"]},"pool":{"type":["string","null"]},"stage":{"type":["string","null"]}},"type":"object"},"UnitDependencies":{"anyOf":[{"type":"null"},{"items":{"type":"string"},"type":"array"},{"type":"string"}]},"ValidationCheck":{"additionalProperties":false,"properties":{"check":{"type":"string"},"message":{"type":"string"}},"required":["check","message"],"type":"object"},"Worker":{"oneOf":[{"additionalProperties":false,"properties":{"creates":{"items":{"type":"string"},"type":"array"},"gated_review":{"anyOf":[{"$ref":"#/$defs/GatedReviewAccess"},{"type":"null"}]},"inputs":{"additionalProperties":{"type":"string"},"type":"object"},"kind":{"const":"agent","type":"string"},"prompts":{"$ref":"#/$defs/Prompts"},"reviews":{"type":["string","null"]},"runtime":{"anyOf":[{"$ref":"#/$defs/WorkerRuntime"},{"type":"null"}]},"session":{"anyOf":[{"$ref":"#/$defs/SessionMode"},{"type":"null"}]},"when":{"description":"Optional guard: the worker is wanted only while it holds, and the\nartifacts it proves published type the worker's inputs.","type":["string","null"]},"workspace":{"type":["string","null"]}},"required":["kind","prompts","inputs","creates"],"type":"object"},{"additionalProperties":false,"properties":{"creates":{"items":{"type":"string"},"type":"array"},"every":{"type":["string","null"]},"inputs":{"additionalProperties":{"type":"string"},"type":"object"},"kind":{"const":"code","type":"string"},"operation":{"type":"string"},"when":{"type":["string","null"]}},"required":["kind","operation","inputs","creates"],"type":"object"}]},"WorkerOverrides":{"additionalProperties":false,"properties":{"creates":{"items":{"type":"string"},"type":["array","null"]},"every":{"type":["string","null"]},"gated_review":{"anyOf":[{"$ref":"#/$defs/GatedReviewAccess"},{"type":"null"}]},"inputs":{"additionalProperties":{"type":"string"},"type":["object","null"]},"operation":{"type":["string","null"]},"prompts":{"anyOf":[{"$ref":"#/$defs/Prompts"},{"type":"null"}]},"reviews":{"type":["string","null"]},"runtime":{"anyOf":[{"$ref":"#/$defs/WorkerRuntime"},{"type":"null"}]},"session":{"anyOf":[{"$ref":"#/$defs/SessionMode"},{"type":"null"}]},"when":{"type":["string","null"]},"workspace":{"type":["string","null"]}},"type":"object"},"WorkerRuntime":{"additionalProperties":false,"properties":{"harness":{"type":"string"},"model":{"type":"string"}},"required":["harness","model"],"type":"object"},"WorkerUse":{"additionalProperties":false,"properties":{"overrides":{"anyOf":[{"$ref":"#/$defs/WorkerOverrides"},{"type":"null"}],"default":null},"template":{"type":"string"}},"required":["template"],"type":"object"}},"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,"description":"The authoring surface before reusable declarations are expanded into a\npinned `Workflow`. This is also the source schema used by the editor.","properties":{"decisions":{"additionalProperties":{"additionalProperties":{"$ref":"#/$defs/ReviewDecision"},"type":"object"},"default":{},"type":"object"},"input":{"$ref":"#/$defs/Type"},"operations":{"type":["string","null"]},"reviews":{"additionalProperties":{"$ref":"#/$defs/Review"},"default":{},"type":"object"},"run":{"$ref":"#/$defs/Group"},"schemas":{"additionalProperties":{"$ref":"#/$defs/Type"},"default":{},"type":"object"},"stages":{"additionalProperties":{"$ref":"#/$defs/AuthoredStage"},"type":"object"},"workers":{"additionalProperties":{"$ref":"#/$defs/Worker"},"default":{},"type":"object"},"workflow":{"type":"string"}},"required":["workflow","input","run","stages"],"title":"AuthoredWorkflow","type":"object"} as const;
export type Artifact = { readonly "edit_policy"?: EditPolicy; readonly "schema": TypeExpression; readonly "validate"?: (ValidationCheck)[] };
export type AuthoredDecisions = { readonly [key: string]: ReviewDecision } | DecisionSetUse;
export type AuthoredReview = AuthoredReviewDefinition | ReviewUse;
export type AuthoredReviewDefinition = { readonly "by": ReviewBy; readonly "decisions": AuthoredDecisions; readonly "inputs"?: { readonly [key: string]: string }; readonly "of": string; readonly "prompt"?: string | null; readonly "when"?: string | null };
export type AuthoredStage = { readonly "artifacts": { readonly [key: string]: Artifact }; readonly "done_when"?: string | null; readonly "input": TypeExpression; readonly "let"?: { readonly [key: string]: string }; readonly "outcome": { readonly [key: string]: string }; readonly "reviews"?: { readonly [key: string]: AuthoredReview }; readonly "workers": { readonly [key: string]: AuthoredWorker } };
export type AuthoredWorker = Worker | WorkerUse;
export type DecisionOverrides = { readonly "feedback"?: string | null; readonly "fields"?: { readonly [key: string]: string } | null; readonly "label"?: string | null; readonly "on"?: string | null; readonly "payload"?: TypeExpression | null };
export type DecisionSetUse = { readonly "overrides"?: { readonly [key: string]: DecisionOverrides }; readonly "rename"?: { readonly [key: string]: string }; readonly "set": string };
export type DeclaredDecisionEffect = "approve" | "request_changes";
export type EditPolicy = { readonly "kind": "always" } | { readonly "kind": "frozen_when_accepted" };
export type GatedReviewAccess = { readonly "kind": "restricted"; readonly "role": GatedReviewRole } | { readonly "kind": "unscoped" };
export type GatedReviewRole = "builder" | "assessor";
export type Group = { readonly "outcome": { readonly [key: string]: string }; readonly "pools"?: { readonly [key: string]: number }; readonly "units": { readonly [key: string]: Unit } };
export type Prompts = { readonly "handoff"?: string | null; readonly "initial"?: string | null; readonly "review"?: string | null; readonly "revise"?: string | null };
export type Review = { readonly "by": ReviewBy; readonly "decisions": { readonly [key: string]: ReviewDecision }; readonly "inputs"?: { readonly [key: string]: string }; readonly "of": string; readonly "prompt"?: string | null; readonly "when"?: string | null };
export type ReviewBy = "operator" | "engine";
export type ReviewDecision = { readonly "effect": DeclaredDecisionEffect; readonly "feedback"?: string | null; readonly "fields"?: { readonly [key: string]: string }; readonly "label": string; readonly "on"?: string | null; readonly "payload"?: TypeExpression | null };
export type ReviewOverrides = { readonly "decisions"?: { readonly [key: string]: DecisionOverrides } | null; readonly "inputs"?: { readonly [key: string]: string } | null; readonly "of"?: string | null; readonly "prompt"?: string | null; readonly "when"?: string | null };
export type ReviewUse = { readonly "overrides"?: ReviewOverrides | null; readonly "template": string };
export type SessionMode = "resume" | "fresh" | "shared";
export type Type = string | { readonly [key: string]: TypeExpression };
export type Unit = { readonly "after"?: UnitDependencies; readonly "for_each"?: string | null; readonly "group"?: Group | null; readonly "input"?: { readonly [key: string]: string }; readonly "key"?: string | null; readonly "pool"?: string | null; readonly "stage"?: string | null };
export type UnitDependencies = null | (string)[] | string;
export type ValidationCheck = { readonly "check": string; readonly "message": string };
export type Worker = { readonly "creates": (string)[]; readonly "gated_review"?: GatedReviewAccess | null; readonly "inputs": { readonly [key: string]: string }; readonly "kind": "agent"; readonly "prompts": Prompts; readonly "reviews"?: string | null; readonly "runtime"?: WorkerRuntime | null; readonly "session"?: SessionMode | null; readonly "when"?: string | null; readonly "workspace"?: string | null } | { readonly "creates": (string)[]; readonly "every"?: string | null; readonly "inputs": { readonly [key: string]: string }; readonly "kind": "code"; readonly "operation": string; readonly "when"?: string | null };
export type WorkerOverrides = { readonly "creates"?: (string)[] | null; readonly "every"?: string | null; readonly "gated_review"?: GatedReviewAccess | null; readonly "inputs"?: { readonly [key: string]: string } | null; readonly "operation"?: string | null; readonly "prompts"?: Prompts | null; readonly "reviews"?: string | null; readonly "runtime"?: WorkerRuntime | null; readonly "session"?: SessionMode | null; readonly "when"?: string | null; readonly "workspace"?: string | null };
export type WorkerRuntime = { readonly "harness": string; readonly "model": string };
export type WorkerUse = { readonly "overrides"?: WorkerOverrides | null; readonly "template": string };
export type TypeExpression = Type;
export type WorkflowDefinitionDescriptor = { readonly "decisions"?: { readonly [key: string]: { readonly [key: string]: ReviewDecision } }; readonly "input": TypeExpression; readonly "operations"?: string | null; readonly "reviews"?: { readonly [key: string]: Review }; readonly "run": Group; readonly "schemas"?: { readonly [key: string]: TypeExpression }; readonly "stages": { readonly [key: string]: AuthoredStage }; readonly "workers"?: { readonly [key: string]: Worker }; readonly "workflow": string };
// Decoder generated with the schema above; arbitrary JSON is confined to this boundary.
type ProtocolSchema = boolean | ProtocolSchemaObject;
interface ProtocolSchemaObject {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly oneOf?: readonly ProtocolSchema[];
  readonly anyOf?: readonly ProtocolSchema[];
  readonly allOf?: readonly ProtocolSchema[];
  readonly required?: readonly string[];
  readonly properties?: { readonly [key: string]: ProtocolSchema };
  readonly additionalProperties?: boolean | ProtocolSchema;
  readonly items?: ProtocolSchema;
  readonly minimum?: number;
  readonly maximum?: number;
}
// Runaway guards, not domain limits: the generator fills these in from workflow-model::protocol,
// sized above the deepest document the Rust side can emit.
const MAX_JSON_DEPTH = 256;
const MAX_SCHEMA_HOPS = 1024;
export function hasSafeWireNumbers(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  if (Array.isArray(value)) return value.every((member) => hasSafeWireNumbers(member, depth + 1));
  if (typeof value === "object" && value !== null) return Object.values(value).every((member) => hasSafeWireNumbers(member, depth + 1));
  return true;
}
function matchesProtocolSchema(value: unknown, schema: ProtocolSchema, definitions: { readonly [key: string]: ProtocolSchema }, depth: number): boolean {
  if (depth > MAX_SCHEMA_HOPS) return false;
  if (typeof schema === "boolean") return schema;
  if (schema.$ref) {
    const resolved = definitions[schema.$ref.replace("#/$defs/", "")];
    return resolved !== undefined && matchesProtocolSchema(value, resolved, definitions, depth + 1);
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.oneOf && schema.oneOf.filter((member) => matchesProtocolSchema(value, member, definitions, depth + 1)).length !== 1) return false;
  if (schema.anyOf && !schema.anyOf.some((member) => matchesProtocolSchema(value, member, definitions, depth + 1))) return false;
  if (schema.allOf && !schema.allOf.every((member) => matchesProtocolSchema(value, member, definitions, depth + 1))) return false;
  const types = typeof schema.type === "string" ? [schema.type] : schema.type;
  if (types && !types.some((type) => type === "null" ? value === null
    : type === "array" ? Array.isArray(value)
    : type === "object" ? typeof value === "object" && value !== null && !Array.isArray(value)
    : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
    : type === "number" ? typeof value === "number" && Number.isFinite(value)
    : typeof value === type)) return false;
  if (typeof value === "number" && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) return false;
  const itemSchema = schema.items;
  if (Array.isArray(value) && itemSchema && !value.every((member) => matchesProtocolSchema(member, itemSchema, definitions, depth + 1))) return false;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as { readonly [key: string]: unknown };
    if (schema.required?.some((key) => !Object.hasOwn(record, key))) return false;
    for (const [key, member] of Object.entries(record)) {
      const property = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties?.[key] : undefined;
      if (property !== undefined && !matchesProtocolSchema(member, property, definitions, depth + 1)) return false;
      if (property === undefined && schema.additionalProperties === false) return false;
      if (property === undefined && typeof schema.additionalProperties === "object" && !matchesProtocolSchema(member, schema.additionalProperties, definitions, depth + 1)) return false;
    }
  }
  return true;
}
export function decodeWorkflowSource(value: unknown): WorkflowDefinitionDescriptor | null {
  return hasSafeWireNumbers(value) && matchesProtocolSchema(value, SOURCE_SCHEMA, SOURCE_SCHEMA.$defs, 0)
    ? value as WorkflowDefinitionDescriptor : null;
}
