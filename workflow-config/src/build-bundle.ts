import { defineBundle } from "./builder";
import type { WorkflowDefinitionDescriptor } from "./source-contracts";
import type { AuthoringError, PromptBinding, WorkflowAuthoring } from "./authoring";
import { buildPrompts, resolvePromptKeys } from "./development/prompts";
import { developmentSchemas } from "./development/schemas";
import { stageTableFor } from "./development/run/stage-table";
import { operations } from "./development/operations";
import { configureSchemas, configureScope, type RunPolicy } from "./development/policies";
import { buildDevelopmentScope } from "./development/run/scope";
import { repository_preparation } from "./development/stages/repository_preparation/scope";
import { spec_analysis } from "./development/stages/spec_analysis/scope";
import { planning } from "./development/stages/planning/scope";
import { brief_writing } from "./development/stages/brief_writing/scope";
import { implementation } from "./development/stages/implementation/scope";
import { final_integration } from "./development/stages/final_integration/scope";
import { ACTION_TEMPLATE_SLOTS, IMPLEMENTATION_STAGE_SLOTS, INTEGRATION_STAGE_SLOTS, OBSERVER_TEMPLATE_SLOTS, REPOSITORY_PREPARATION_STAGE_SLOTS, TASK_STAGE_SLOTS } from "./authoring";
import { record } from "./primitives/expressions";
import { field, recordSchema } from "./primitives/schemas";
import type { Expression, FieldExpression, Schema } from "./source-contracts";

export type BuildBundleResult =
  | { readonly ok: true; readonly value: WorkflowDefinitionDescriptor }
  | { readonly ok: false; readonly error: AuthoringError };

function invalid(field_path: string, detail: string): BuildBundleResult {
  return { ok: false, error: { kind: "authoring_error", field_path, detail } };
}

class MissingTemplateSlotError extends Error {
  readonly field_path: string;

  constructor(schema: string, role: string) {
    super(`template ${schema} is missing slot ${role}`);
    this.field_path = `template.slots.${schema}.${role}`;
  }
}

function assembleDevelopmentRun(policy: RunPolicy): WorkflowDefinitionDescriptor {
  return {
    language_version: 1,
    key: policy.key,
    version: 3,
    root: "development",
    schemas: configureSchemas(policy.stage_layout === "verification"
      ? [...developmentSchemas, recordSchema("run_input_verification", [
        field("spec", "text"), field("repositories", "repository_configs"),
        field("analysis", "session_config"), field("planning", "session_config"),
        field("briefs", "session_config"), field("admission", "admission_flags"), field("final_merge_policy", "final_merge_policy"), field("verification_note", "optional_text")
      ])] : developmentSchemas, policy),
    scopes: [
      buildDevelopmentScope(policy),
      repository_preparation,
      spec_analysis,
      planning,
      brief_writing,
      implementation,
      final_integration,
    ].map((scope) => configureScope(scope, policy)),
    prompts: buildPrompts(stageTableFor(policy)),
    operations,
    limits: { max_list_items: 100, max_depth: 28, evaluation_budget: 20000 },
  };
}

/** The sole producer of complete source bundles. */
export function buildBundle(value: unknown): BuildBundleResult {
  if (!value || typeof value !== "object") return invalid("", "authoring must be an object");
  const authoring = value as WorkflowAuthoring;
  if (authoring.authoring_version !== 1) return invalid("authoring_version", "unsupported authoring version");
  if (authoring.template !== "development") return invalid("template", "unknown workflow template");
  if (!authoring.key || !/^[a-z][a-z0-9-]*$/.test(authoring.key)) return invalid("key", "invalid workflow key");
  if (!Number.isSafeInteger(authoring.implementation_capacity) || authoring.implementation_capacity < 1
    || authoring.implementation_capacity > 4_294_967_295)
    return invalid("implementation_capacity", "capacity must be a positive integer");
  if (authoring.sibling_failure !== "cancel" && authoring.sibling_failure !== "continue_independent")
    return invalid("sibling_failure", "unknown sibling failure policy");
  if (authoring.wire_field_order !== "canonical" && authoring.wire_field_order !== "alternate")
    return invalid("wire_field_order", "unknown field order");
  if (authoring.stage_layout !== "standard" && authoring.stage_layout !== "verification")
    return invalid("stage_layout", "unknown stage layout");
  if (authoring.prompt_bindings !== undefined && !Array.isArray(authoring.prompt_bindings))
    return invalid("prompt_bindings", "prompt bindings must be a list");
  try { return buildValidated(authoring); }
  catch (cause) {
    if (cause instanceof MissingTemplateSlotError) return invalid(cause.field_path, cause.message);
    return invalid("template", String(cause));
  }
}

function buildValidated(authoring: WorkflowAuthoring): BuildBundleResult {
  const assembled = assembleDevelopmentRun({
    key: authoring.key,
    implementation_capacity: authoring.implementation_capacity,
    sibling_failure: authoring.sibling_failure,
    contract_field_order: authoring.wire_field_order,
    stage_layout: authoring.stage_layout,
  });
  const rebuilt = { ...assembled, schemas: assembled.schemas.map(synthesizeSchema), scopes: assembled.scopes.map((scope) => ({ ...scope,
    children: scope.children.map((child) => ({ ...child, input: synthesizeRecord(child.input),
      collection: child.collection?.source.kind === "map" ? { ...child.collection,
        source: { ...child.collection.source, value: synthesizeRecord(child.collection.source.value) } } : child.collection })),
    workers: scope.workers.map((worker) => ({ ...worker, actions: worker.actions.map((action) => ({
      ...action, input: synthesizeRecord(action.input),
    })) })),
  })) };
  const bound = bindPrompts(rebuilt, authoring.prompt_bindings ?? []);
  if (!bound.ok) return bound;
  const resolved = resolvePromptKeys(bound.value);
  if (!resolved.ok) {
    const index = authoring.prompt_bindings?.findIndex((binding) => binding.prompt_key === resolved.key) ?? -1;
    return invalid(index >= 0 ? `prompt_bindings[${index}].prompt_key` : `prompts.${resolved.key}`, resolved.detail);
  }
  return { ok: true, value: structuredClone(defineBundle(resolved.value)) };
}

function bindPrompts(bundle: WorkflowDefinitionDescriptor, bindings: readonly PromptBinding[]):
  { readonly ok: true; readonly value: WorkflowDefinitionDescriptor } | { readonly ok: false; readonly error: AuthoringError } {
  if (bindings.length === 0) return { ok: true, value: bundle };
  const updates = new Map<string, string>();
  const prompts = [...bundle.prompts];
  for (const [index, binding] of bindings.entries()) {
    const path = `prompt_bindings[${index}]`;
    if (!binding || typeof binding !== "object") return { ok: false, error: { kind: "authoring_error", field_path: path, detail: "binding must be an object" } };
    const stage = bundle.scopes.find((item) => item.key === bundle.root)?.children.find((item) => item.key === binding.stage_key);
    const scope = bundle.scopes.find((item) => item.key === stage?.scope);
    if (!scope) return { ok: false, error: { kind: "authoring_error", field_path: `${path}.stage_key`, detail: "unknown stage" } };
    const worker = scope.workers.find((item) => item.key === binding.worker_key);
    if (!worker) return { ok: false, error: { kind: "authoring_error", field_path: `${path}.worker_key`, detail: "unknown worker" } };
    const action = worker.actions.find((item) => item.key === binding.action_key);
    if (!action) return { ok: false, error: { kind: "authoring_error", field_path: `${path}.action_key`, detail: "unknown action" } };
    if (typeof binding.prompt_key !== "string" || !binding.prompt_key)
      return { ok: false, error: { kind: "authoring_error", field_path: `${path}.prompt_key`, detail: "prompt key is required" } };
    const address = `${scope.key}/${binding.worker_key}/${binding.action_key}`;
    if (updates.has(address)) return { ok: false, error: { kind: "authoring_error", field_path: path, detail: "duplicate action binding" } };
    updates.set(address, binding.prompt_key);
    const existing = prompts.find((prompt) => prompt.key === binding.prompt_key);
    if (existing && existing.input_schema !== action.input_schema)
      return { ok: false, error: { kind: "authoring_error", field_path: `${path}.prompt_key`, detail: "prompt input schema differs from action" } };
    if (!existing)
      prompts.push({ key: binding.prompt_key, path: "", content_digest: "", input_schema: action.input_schema });
  }
  return { ok: true, value: { ...bundle, prompts, scopes: bundle.scopes.map((scope) => ({ ...scope,
    workers: scope.workers.map((worker) => ({ ...worker, actions: worker.actions.map((action) => ({ ...action,
      prompt: updates.get(`${scope.key}/${worker.key}/${action.key}`) ?? action.prompt,
    })) })),
  })) } };
}

function synthesizeSchema(schema: Schema): Schema {
  const slots = schema.key === "repo_input" ? REPOSITORY_PREPARATION_STAGE_SLOTS
    : schema.key === "task_input" ? TASK_STAGE_SLOTS
    : schema.key === "implementation_input" ? IMPLEMENTATION_STAGE_SLOTS
    : schema.key === "integration_input" ? INTEGRATION_STAGE_SLOTS
    : schema.key === "session_action" ? ACTION_TEMPLATE_SLOTS
    : schema.key === "pr_observe_input" ? OBSERVER_TEMPLATE_SLOTS : null;
  return slots ? recordSchema(schema.key, slots.map(({ role, schema: pinned }) => field(role, pinned))) : schema;
}

/** Rebuild records from fixed template roles while leaving nested joins in the template. */
function synthesizeRecord(input: Expression): Expression {
  if (input.kind !== "record") return input;
  const slots = input.schema === "task_input" ? TASK_STAGE_SLOTS
    : input.schema === "implementation_input" ? IMPLEMENTATION_STAGE_SLOTS
    : input.schema === "integration_input" ? INTEGRATION_STAGE_SLOTS
    : input.schema === "session_action" ? ACTION_TEMPLATE_SLOTS
    : input.schema === "pr_observe_input" ? OBSERVER_TEMPLATE_SLOTS : null;
  const fields: FieldExpression[] = (slots ?? input.fields.map(({ key }) => ({ role: key }))).map(({ role }) => {
    const field = input.fields.find((candidate) => candidate.key === role);
    if (!field) throw new MissingTemplateSlotError(input.schema, role);
    return { ...field, value: synthesizeRecord(field.value) };
  });
  return record(input.schema, fields);
}
