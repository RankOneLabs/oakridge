import type { MaterializedExecutionUnit } from "../domain/compiled-workflow";
import { isDelegatedRuntimeId, type Bindable, type DelegatedSessionDefinitionConfig, type ResolvedExecutorConfig, type SlotBinding } from "../domain/delegated-session";
import type { ArtifactEnvelope } from "../domain/execution";
import { err, ok, type JsonValue, type Result, type StageInstanceId } from "../domain/primitives";
import { readJsonPointer } from "../domain/json-pointer";

export interface ResolveExecutionError { readonly operation: "resolve_execution"; readonly detail: string }
export interface BindingEnvironment {
  readonly inputs: Readonly<Record<string, ArtifactEnvelope | readonly ArtifactEnvelope[]>>;
  readonly context: JsonValue;
  readonly item: JsonValue | null;
}
export interface ResolveDelegatedExecutionInput {
  readonly definition: DelegatedSessionDefinitionConfig;
  readonly environment: BindingEnvironment;
  readonly unit: MaterializedExecutionUnit;
  readonly stage_instance_id: StageInstanceId;
  readonly prompt_template: string;
}


const stringify = (value: JsonValue): string => typeof value === "string" ? value : value === null ? "null" : typeof value === "object" ? JSON.stringify(value) : String(value);
const inputBindingValue = (input: ArtifactEnvelope | readonly ArtifactEnvelope[]): JsonValue => Array.isArray(input)
  ? input.map((artifact) => ({ unit_id: artifact.unit_id, artifact: artifact.body }))
  : (input as ArtifactEnvelope).body;

export const resolveBindingValue = (binding: SlotBinding, environment: BindingEnvironment): Result<JsonValue, ResolveExecutionError> => {
  if (binding.from === "literal") return ok(binding.value);
  if (binding.from === "input") {
    const input = environment.inputs[binding.input_name];
    if (!input) return err({ operation: "resolve_execution", detail: `input '${binding.input_name}' not found` });
    const source = inputBindingValue(input);
    const value = binding.path == null ? source : readJsonPointer(source, binding.path);
    return value === undefined ? err({ operation: "resolve_execution", detail: `input pointer '${binding.path}' not found` }) : ok(value);
  }
  if (binding.from === "context") {
    const value = readJsonPointer(environment.context, binding.path);
    return value === undefined ? err({ operation: "resolve_execution", detail: `context pointer '${binding.path}' not found` }) : ok(value);
  }
  if (binding.from === "item") {
    if (environment.item === null) return err({ operation: "resolve_execution", detail: "item binding used outside fan-out" });
    const value = readJsonPointer(environment.item, binding.path);
    return value === undefined ? err({ operation: "resolve_execution", detail: `item pointer '${binding.path}' not found` }) : ok(value);
  }
  // Both lookups pick one entry out of a collection using a key the fan-out item
  // carries. They differ only in where the collection comes from — the run
  // context, or a named input holding an upstream stage's typed output.
  const lookup = binding.from === "context_lookup" ? "context lookup" : "input lookup";
  if (environment.item === null) return err({ operation: "resolve_execution", detail: `${lookup} used outside fan-out` });
  const itemKey = readJsonPointer(environment.item, binding.item_key_path);
  if (typeof itemKey !== "string" || itemKey.length === 0) return err({ operation: "resolve_execution", detail: `${lookup} item key '${binding.item_key_path}' must be a non-empty string` });
  let collection: JsonValue | undefined;
  let source: string;
  if (binding.from === "context_lookup") {
    collection = readJsonPointer(environment.context, binding.collection_path);
    source = binding.collection_path;
  } else {
    const input = environment.inputs[binding.input_name];
    if (!input) return err({ operation: "resolve_execution", detail: `input '${binding.input_name}' not found` });
    collection = inputBindingValue(input);
    source = binding.input_name;
  }
  if (!Array.isArray(collection)) return err({ operation: "resolve_execution", detail: `${lookup} collection '${source}' must be an array` });
  const matches = collection.filter((entry) => readJsonPointer(entry, binding.collection_key_path) === itemKey);
  if (matches.length !== 1) return err({ operation: "resolve_execution", detail: `${lookup} key '${itemKey}' matched ${matches.length} entries in '${source}'` });
  const value = readJsonPointer(matches[0] as JsonValue, binding.value_path);
  return value === undefined ? err({ operation: "resolve_execution", detail: `${lookup} value '${binding.value_path}' not found` }) : ok(value);
};

export const resolveBinding = (binding: SlotBinding, environment: BindingEnvironment): Result<string, ResolveExecutionError> => {
  const value = resolveBindingValue(binding, environment);
  return value.ok ? ok(stringify(value.value)) : value;
};

const resolveBindable = (value: Bindable | undefined, environment: BindingEnvironment): Result<string | null, ResolveExecutionError> => {
  if (value === undefined) return ok(null);
  if (typeof value === "string") return ok(value);
  const resolved = resolveBindingValue(value, environment);
  return resolved.ok ? ok(resolved.value === null ? null : stringify(resolved.value)) : resolved;
};

const renderPrompt = (template: string, slots: Readonly<Record<string, string>>): Result<string, ResolveExecutionError> => {
  let missing: string | null = null;
  const rendered = template.replace(/\{\{([^{}]+)\}\}/g, (_match, key: string) => {
    const value = slots[key];
    if (value === undefined) { missing = key; return ""; }
    return value;
  });
  return missing ? err({ operation: "resolve_execution", detail: `template slot '{{${missing}}}' has no binding` }) : ok(rendered);
};

/**
 * Slots that name *which execution this is*. A definition may not rebind them.
 *
 * These are facts about the unit being launched, not choices a definition gets
 * to make, and everything downstream addresses the execution by them —
 * they're what names this execution in the rendered prompt's own context
 * lines, and in every artifact the agent files against it. A definition that
 * bound `UNIT_ID` to the literal `"0"` — left over from before the stage
 * fanned out — silently overwrote the real unit id, so a build agent did its
 * whole job under the wrong identity: right code, mislabeled execution.
 * Meanwhile the worktree and session name came out right, because those
 * substitute the unit id directly rather than through the slot table. One
 * execution, two identities.
 *
 * So identity is applied last and wins. The alternative — rejecting a
 * definition that binds one of these — is the stricter rule, but it would hard
 * fail every already-seeded definition carrying the stale binding, and being
 * unable to launch is not an improvement on launching correctly.
 */
const IDENTITY_SLOTS = ["UNIT_ID", "STAGE_INSTANCE_ID"] as const;

export const resolveDelegatedExecution = (input: ResolveDelegatedExecutionInput): Result<ResolvedExecutorConfig, ResolveExecutionError> => {
  const environment = { ...input.environment, item: input.unit.parameters };
  const slots: Record<string, string> = {};
  for (const [name, binding] of Object.entries(input.definition.slot_bindings)) {
    const value = resolveBinding(binding, environment);
    if (!value.ok) return value;
    slots[name] = value.value;
  }
  for (const [name, binding] of Object.entries(input.definition.fan_out?.item_bindings ?? {})) {
    const value = resolveBinding(binding, environment);
    if (!value.ok) return value;
    slots[name] = value.value;
  }
  const identity = {
    UNIT_ID: input.unit.unit_id,
    STAGE_INSTANCE_ID: input.stage_instance_id,
  } satisfies Record<(typeof IDENTITY_SLOTS)[number], string>;
  Object.assign(slots, identity);
  const prompt = renderPrompt(input.prompt_template, slots);
  if (!prompt.ok) return prompt;
  const runtime = resolveBindable(input.definition.runtime, environment);
  const model = resolveBindable(input.definition.model, environment);
  const effort = resolveBindable(input.definition.effort, environment);
  const workdirBinding = input.definition.fan_out?.workdir ?? input.definition.workdir;
  const workdir = resolveBinding(workdirBinding, environment);
  if (!runtime.ok) return runtime;
  if (!model.ok) return model;
  if (!effort.ok) return effort;
  if (!workdir.ok) return workdir;
  if (!isDelegatedRuntimeId(runtime.value)) return err({ operation: "resolve_execution", detail: `unsupported delegated runtime '${runtime.value}'` });
  const worktreeTemplate = input.definition.fan_out?.worktree;
  const substituteIdentity = (value: string): string => value.replaceAll("{{UNIT_ID}}", input.unit.unit_id).replaceAll("{{STAGE_INSTANCE_ID}}", input.stage_instance_id);
  let worktree: ResolvedExecutorConfig["worktree"];
  if (worktreeTemplate) {
    const branchName = resolveBindable(worktreeTemplate.branch_name, environment);
    const worktreeSubdir = resolveBindable(worktreeTemplate.worktree_subdir, environment);
    const baseRef = resolveBindable(worktreeTemplate.base_ref, environment);
    if (!branchName.ok) return branchName;
    if (!worktreeSubdir.ok) return worktreeSubdir;
    if (!baseRef.ok) return baseRef;
    if (!branchName.value || !worktreeSubdir.value) return err({ operation: "resolve_execution", detail: "worktree branch name and subdirectory must resolve to non-empty strings" });
    worktree = { branchName: substituteIdentity(branchName.value), worktreeSubdir: substituteIdentity(worktreeSubdir.value),
      ...(baseRef.value ? { baseRef: substituteIdentity(baseRef.value) } : {}) };
  }
  return ok({ executor_type: "delegated_session", runtime: runtime.value, rendered_prompt: prompt.value, workdir: workdir.value,
    session_name: substituteIdentity(input.definition.session_name),
    model: model.value, effort: effort.value, ...(worktree ? { worktree } : {}),
    executor_options: { pre_authorized_tools: input.definition.pre_authorized_tools ?? [], yolo: input.definition.yolo ?? false } });
};
