import { z } from "zod";
import { BUILT_IN_GATE_DISPOSITIONS, isBuiltInGateAction } from "../domain/gates";
import type { DelegatedSessionDefinitionConfig, SessionLaunchReasonName } from "../domain/delegated-session";
import type { JsonValue } from "../domain/primitives";
import type { StageOperatorRole } from "../domain/workflow";
import type { AdapterRoleRegistry } from "./workflow-definition";

export const slotBindingSchema = z.discriminatedUnion("from", [
  z.object({ from: z.literal("input"), input_name: z.string().min(1), path: z.string().nullable().default(null) }),
  z.object({ from: z.literal("context"), path: z.string() }),
  z.object({ from: z.literal("literal"), value: z.string() }),
  z.object({ from: z.literal("item"), path: z.string() }),
  z.object({
    from: z.literal("context_lookup"),
    collection_path: z.string(),
    collection_key_path: z.string(),
    item_key_path: z.string(),
    value_path: z.string(),
  }),
  z.object({
    from: z.literal("input_lookup"),
    input_name: z.string().min(1),
    collection_key_path: z.string(),
    item_key_path: z.string(),
    value_path: z.string(),
  }),
]);

export const bindableSchema = z.union([z.string(), slotBindingSchema]);

/** Role vocabulary is supplied by the selected adapter, not by core schema. */
const roleSchema = z.string().min(1);
const launchReasonSchema = z.string().min(1);

const outputGateSchema = z.object({
  name: z.string().min(1),
  outputs: z.array(z.string().min(1)).min(1),
  steps: z.array(z.object({
    type: z.enum(["artifact_approval", "merge_confirmation"]),
    actions: z.array(z.string().min(1)).min(1),
  })),
  requires_zero_open_review_items: z.boolean().default(false),
}).superRefine((gate, context) => {
  const seen = new Set<string>();
  for (const step of gate.steps) {
    if (seen.has(step.type)) context.addIssue({ code: "custom", message: `output_gate step type '${step.type}' must be unique` });
    seen.add(step.type);
    // An action with no known disposition used to compile fine and then behave
    // as a rejection at runtime, failing the stage with `required_output_missing`
    // long after the definition that caused it was accepted.
    for (const action of step.actions) {
      if (isBuiltInGateAction(action)) continue;
      context.addIssue({ code: "custom", message: `output_gate step '${step.type}' action '${action}' has no known disposition; expected one of ${Object.keys(BUILT_IN_GATE_DISPOSITIONS).join(", ")}` });
    }
  }
});

const LEGACY_REVISION_ROUTE_FIELD = ["revision", "target"].join("_");
const legacyOutputGateSchema = z.object({
  output: z.string().min(1),
  steps: z.array(z.object({ type: z.enum(["artifact_approval", "merge_confirmation"]), actions: z.array(z.string().min(1)).min(1) })).min(1),
  requires_zero_open_review_items: z.boolean().default(false),
}).passthrough().transform((gate) => ({ ...gate,
  legacy_revision_route: gate[LEGACY_REVISION_ROUTE_FIELD] === "upstream_handoff" ? "upstream_handoff" as const : "self_stage" as const }));

const legacyDelegatedSessionDefinitionSchema = z.object({
  runtime: bindableSchema,
  prompt_template_path: z.string().min(1),
  slot_bindings: z.record(z.string(), slotBindingSchema),
  workdir: slotBindingSchema,
  session_name: z.string().min(1),
  model: bindableSchema.optional(), effort: bindableSchema.optional(),
  worktree: z.object({ branchName: bindableSchema, worktreeSubdir: bindableSchema, baseRef: bindableSchema.optional() }).optional(),
  pre_authorized_tools: z.array(z.string()).default([]), yolo: z.boolean().default(false),
  fan_out: z.object({ over: slotBindingSchema, unit_id_path: z.string().min(1), session_mode: z.enum(["per_unit", "shared"]).default("per_unit"),
    depends_on_path: z.string().nullable().optional(), max_parallel: z.number().int().positive().default(8), manual_admission: z.boolean().default(false),
    item_bindings: z.record(z.string(), slotBindingSchema).default({}), workdir: slotBindingSchema.optional(),
    worktree: z.object({ branch_name: bindableSchema, worktree_subdir: bindableSchema, base_ref: bindableSchema.optional() }).optional() }).optional(),
  artifacts: z.object({ over: slotBindingSchema, id_path: z.string().min(1) }).optional(),
  gate_output: z.string().optional(), output_gate: legacyOutputGateSchema.optional(),
  output_handoff: z.object({ output: z.string().min(1), downstream_role: roleSchema,
    approved_wait: z.object({ kind: z.string().min(1) }) }).optional(),
});

export interface LegacyRevisionPolicy {
  readonly target: "self_stage" | "upstream_handoff";
  readonly action: string;
}

export const legacyRevisionPolicyOf = (input: unknown): LegacyRevisionPolicy | null => {
  const parsed = legacyDelegatedSessionDefinitionSchema.safeParse(input);
  if (parsed.success && parsed.data.gate_output) return { target: "self_stage", action: "request_revision" };
  const gate = parsed.success ? parsed.data.output_gate : undefined;
  if (!gate) return null;
  const action = gate.steps.flatMap((step) => step.actions).find((candidate) => BUILT_IN_GATE_DISPOSITIONS[candidate as keyof typeof BUILT_IN_GATE_DISPOSITIONS] === "revise");
  return action ? { target: gate.legacy_revision_route, action } : null;
};

export const legacyHandoffRoleOf = (input: unknown): StageOperatorRole | null => {
  const parsed = legacyDelegatedSessionDefinitionSchema.safeParse(input);
  return parsed.success ? parsed.data.output_handoff?.downstream_role ?? null : null;
};

export const delegatedSessionDefinitionSchema = z.object({
  prompt_matrix: z.array(z.object({
    session_role: roleSchema,
    launch_reason: launchReasonSchema,
    template_path: z.string().min(1),
  })).min(1),
  role_configs: z.array(z.object({
    session_role: roleSchema,
    runtime: bindableSchema,
    session_name: z.string().min(1),
    model: bindableSchema.optional(),
    effort: bindableSchema.optional(),
    worktree: z.object({ branch_name: bindableSchema, worktree_subdir: bindableSchema, base_ref: bindableSchema.optional() }).optional(),
    pre_authorized_tools: z.array(z.string().min(1)).default([]),
    required_tools: z.array(z.string().min(1)).default([]),
    authorized_outputs: z.array(z.string().min(1)),
    yolo: z.boolean().default(false),
  })).min(1),
  required_build_set: z.array(z.string().min(1)).min(1).optional(),
  slot_bindings: z.record(z.string(), slotBindingSchema),
  workdir: slotBindingSchema,
  fan_out: z.object({
    over: slotBindingSchema,
    unit_id_path: z.string().min(1),
    session_mode: z.enum(["per_unit", "shared"]).default("per_unit"),
    depends_on_path: z.string().nullable().optional(),
    max_parallel: z.number().int().positive().default(8),
    manual_admission: z.boolean().default(false),
    item_bindings: z.record(z.string(), slotBindingSchema).default({}),
    workdir: slotBindingSchema.optional(),
  }).optional(),
  artifact_productions: z.array(z.object({ over: slotBindingSchema, id_path: z.string().min(1) })).default([]),
  gates: z.array(outputGateSchema).default([]),
  handoffs: z.array(z.object({
    name: z.string().min(1),
    outputs: z.array(z.string().min(1)).min(1),
    downstream_role: roleSchema,
    approved_wait: z.object({ kind: z.string().min(1), close_events: z.array(z.string().min(1)) }),
  })).default([]),
}).superRefine((config, context) => {
  if (config.fan_out && config.artifact_productions.length > 0) context.addIssue({ code: "custom", message: "fan_out and artifact_productions are mutually exclusive" });
  if (config.prompt_matrix.some((cell) => cell.session_role === "build" && cell.launch_reason === "initial_build")
    && !config.required_build_set) {
    context.addIssue({ code: "custom", message: "the build cohort requires required_build_set" });
  }
  if (config.required_build_set && new Set(config.required_build_set).size !== config.required_build_set.length) {
    context.addIssue({ code: "custom", message: "required_build_set entries must be unique" });
  }
});

/** Decode immutable pre-plural rows into the named plural domain model. */
export const normalizeDelegatedSessionDefinition = (
  input: JsonValue,
  sessionRole: StageOperatorRole | null,
  declaredOutputs: readonly string[],
): JsonValue => {
  if (!input || typeof input !== "object" || !("prompt_template_path" in input)) return input;
  const parsed = legacyDelegatedSessionDefinitionSchema.safeParse(input);
  if (!parsed.success || sessionRole === null) return input;
  const legacy = parsed.data;
  const roleWorktree = legacy.fan_out?.worktree ?? (legacy.worktree ? {
    branch_name: legacy.worktree.branchName, worktree_subdir: legacy.worktree.worktreeSubdir, base_ref: legacy.worktree.baseRef,
  } : undefined);
  return {
    prompt_matrix: LEGACY_LAUNCH_REASONS.map((launch_reason) => ({ session_role: sessionRole, launch_reason, template_path: legacy.prompt_template_path })),
    role_configs: [{ session_role: sessionRole, runtime: legacy.runtime, session_name: legacy.session_name, model: legacy.model,
      effort: legacy.effort, worktree: roleWorktree, pre_authorized_tools: legacy.pre_authorized_tools, required_tools: [],
      authorized_outputs: declaredOutputs, yolo: legacy.yolo }],
    slot_bindings: sessionRole === "build" && legacy.fan_out && !("COHORT_FILES" in legacy.slot_bindings)
      ? { ...legacy.slot_bindings, COHORT_FILES: { from: "item", path: "/files_in_scope" } }
      : legacy.slot_bindings,
    workdir: legacy.workdir,
    fan_out: legacy.fan_out ? { ...legacy.fan_out, worktree: undefined } : undefined,
    artifact_productions: legacy.artifacts ? [legacy.artifacts] : [],
    gates: legacy.output_gate ? [{ name: `${legacy.output_gate.output}_gate`, outputs: [legacy.output_gate.output],
      steps: legacy.output_gate.steps, requires_zero_open_review_items: legacy.output_gate.requires_zero_open_review_items }]
      : legacy.gate_output ? [{ name: `${legacy.gate_output}_gate`, outputs: [legacy.gate_output],
        steps: [{ type: "artifact_approval", actions: ["approve", "request_revision"] },
          { type: "merge_confirmation", actions: ["confirm_merged", "closed_without_merge"] }],
        requires_zero_open_review_items: true }] : [],
    handoffs: legacy.output_handoff ? [{ name: `${legacy.output_handoff.output}_handoff`, outputs: [legacy.output_handoff.output],
      downstream_role: legacy.output_handoff.downstream_role, approved_wait: { kind: legacy.output_handoff.approved_wait.kind, close_events: ["approved"] } }] : [],
  } as unknown as JsonValue;
};

export type DelegatedSessionDiagnostic =
  | { readonly kind: "invalid_stage_config"; readonly stage_key: string; readonly session_role: StageOperatorRole | null; readonly contract_item: "config"; readonly issues: readonly string[] }
  | { readonly kind: "duplicate_key"; readonly stage_key: string; readonly session_role: StageOperatorRole | null; readonly contract_item: string; readonly array: string; readonly key: string }
  | { readonly kind: "prompt_not_total"; readonly stage_key: string; readonly session_role: StageOperatorRole; readonly contract_item: string; readonly launch_reason: SessionLaunchReasonName; readonly matches: number }
  | { readonly kind: "gate_without_closer"; readonly stage_key: string; readonly session_role: StageOperatorRole | null; readonly contract_item: string; readonly gate: string }
  | { readonly kind: "output_producer_count"; readonly stage_key: string; readonly session_role: StageOperatorRole | null; readonly contract_item: string; readonly output: string; readonly producers: number }
  | { readonly kind: "wait_without_closing_event"; readonly stage_key: string; readonly session_role: StageOperatorRole | null; readonly contract_item: string; readonly wait: string }
  | { readonly kind: "unbound_placeholder"; readonly stage_key: string; readonly session_role: StageOperatorRole; readonly contract_item: string; readonly placeholder: string }
  | { readonly kind: "undeclared_output"; readonly stage_key: string; readonly session_role: StageOperatorRole | null; readonly contract_item: string; readonly output: string }
  | { readonly kind: "unavailable_tool"; readonly stage_key: string; readonly session_role: StageOperatorRole; readonly contract_item: string; readonly tool: string }
  | { readonly kind: "selected_role_missing"; readonly stage_key: string; readonly session_role: StageOperatorRole | null; readonly contract_item: "operator_role" }
  | { readonly kind: "prompt_bundle_cell_count"; readonly stage_key: string; readonly session_role: StageOperatorRole; readonly contract_item: string; readonly launch_reason: SessionLaunchReasonName; readonly matches: number }
  | { readonly kind: "automated_assessment_transition"; readonly stage_key: string; readonly session_role: StageOperatorRole | null; readonly contract_item: string; readonly trigger: string };

const LEGACY_LAUNCH_REASONS: readonly SessionLaunchReasonName[] = ["initial", "operator_retry", "input_revision"];

const duplicateDiagnostics = (
  stage_key: string,
  session_role: StageOperatorRole | null,
  array: string,
  keys: readonly string[],
): readonly DelegatedSessionDiagnostic[] => {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([key]) => ({
    kind: "duplicate_key", stage_key, session_role, contract_item: key, array, key,
  }));
};

/** Step 2: prove every plural definition has unique selection keys. */
export const validateDelegatedSessionCardinality = (
  stage_key: string,
  session_role: StageOperatorRole | null,
  config: DelegatedSessionDefinitionConfig,
): readonly DelegatedSessionDiagnostic[] => [
  ...duplicateDiagnostics(stage_key, session_role, "prompt_matrix", config.prompt_matrix.map((entry) => `${entry.session_role}:${entry.launch_reason}`)),
  ...duplicateDiagnostics(stage_key, session_role, "role_configs", config.role_configs.map((entry) => entry.session_role)),
  ...duplicateDiagnostics(stage_key, session_role, "gates", config.gates.map((entry) => entry.name)),
  ...duplicateDiagnostics(stage_key, session_role, "handoffs", config.handoffs.map((entry) => entry.name)),
  ...duplicateDiagnostics(stage_key, session_role, "artifact_productions", config.artifact_productions.map((entry) => `${JSON.stringify(entry.over)}:${entry.id_path}`)),
  ...duplicateDiagnostics(stage_key, session_role, "release_outputs", [...config.gates.flatMap((gate) => gate.outputs), ...config.handoffs.flatMap((handoff) => handoff.outputs)]),
];

const placeholdersOf = (value: string): readonly string[] => [...value.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1] ?? "");

export const validatePromptBundleBindings = (
  stage_key: string,
  config: DelegatedSessionDefinitionConfig,
  promptContents: readonly { readonly session_role: StageOperatorRole; readonly launch_reason: SessionLaunchReasonName; readonly content: string }[],
): readonly DelegatedSessionDiagnostic[] => {
  const bound = new Set([...Object.keys(config.slot_bindings), ...Object.keys(config.fan_out?.item_bindings ?? {}), "UNIT_ID", "STAGE_INSTANCE_ID"]);
  const diagnostics: DelegatedSessionDiagnostic[] = [];
  for (const declared of config.prompt_matrix) {
    const matches = promptContents.filter((prompt) => prompt.session_role === declared.session_role && prompt.launch_reason === declared.launch_reason).length;
    if (matches !== 1) diagnostics.push({ kind: "prompt_bundle_cell_count", stage_key, session_role: declared.session_role,
      contract_item: `${declared.session_role}:${declared.launch_reason}`, launch_reason: declared.launch_reason, matches });
  }
  for (const prompt of promptContents) {
    for (const placeholder of placeholdersOf(prompt.content)) {
      if (bound.has(placeholder)) continue;
      diagnostics.push({ kind: "unbound_placeholder", stage_key, session_role: prompt.session_role,
        contract_item: `${prompt.session_role}:${prompt.launch_reason}:${placeholder}`, placeholder });
    }
  }
  return diagnostics;
};

/** Steps 3–5: totality, contract bindings, and executor capability. */
export const validateDelegatedSessionContracts = (
  stage_key: string,
  session_role: StageOperatorRole | null,
  declared_outputs: readonly string[],
  config: DelegatedSessionDefinitionConfig,
  registry: Pick<AdapterRoleRegistry, "launch_reasons_for">,
): readonly DelegatedSessionDiagnostic[] => {
  const diagnostics: DelegatedSessionDiagnostic[] = [];
  if (session_role === null || !config.role_configs.some((role) => role.session_role === session_role)) diagnostics.push({
    kind: "selected_role_missing", stage_key, session_role, contract_item: "operator_role",
  });
  for (const roleConfig of config.role_configs) {
    for (const launchReason of registry.launch_reasons_for(roleConfig.session_role)) {
      const matches = config.prompt_matrix.filter((entry) => entry.session_role === roleConfig.session_role
        && entry.launch_reason === launchReason).length;
      if (matches !== 1) diagnostics.push({ kind: "prompt_not_total", stage_key, session_role: roleConfig.session_role,
        contract_item: `${roleConfig.session_role}:${launchReason}`, launch_reason: launchReason, matches });
    }
    const available = new Set(roleConfig.pre_authorized_tools ?? []);
    for (const tool of roleConfig.required_tools ?? []) if (!available.has(tool)) diagnostics.push({
      kind: "unavailable_tool", stage_key, session_role: roleConfig.session_role, contract_item: tool, tool,
    });
    const bound = new Set([...Object.keys(config.slot_bindings), ...Object.keys(config.fan_out?.item_bindings ?? {}), "UNIT_ID", "STAGE_INSTANCE_ID"]);
    const templateValues = [roleConfig.session_name, typeof roleConfig.worktree?.branch_name === "string" ? roleConfig.worktree.branch_name : "",
      typeof roleConfig.worktree?.worktree_subdir === "string" ? roleConfig.worktree.worktree_subdir : "",
      typeof roleConfig.worktree?.base_ref === "string" ? roleConfig.worktree.base_ref : ""];
    for (const placeholder of templateValues.flatMap(placeholdersOf)) if (!bound.has(placeholder)) diagnostics.push({
      kind: "unbound_placeholder", stage_key, session_role: roleConfig.session_role, contract_item: placeholder, placeholder,
    });
  }
  for (const gate of config.gates) if (gate.steps.length === 0) diagnostics.push({
    kind: "gate_without_closer", stage_key, session_role, contract_item: gate.name, gate: gate.name,
  });
  for (const handoff of config.handoffs) if (handoff.approved_wait.close_events.length === 0) diagnostics.push({
    kind: "wait_without_closing_event", stage_key, session_role, contract_item: handoff.name, wait: handoff.name,
  });
  const declared = new Set(declared_outputs);
  const claimed = [...config.role_configs.flatMap((role) => role.authorized_outputs), ...config.gates.flatMap((gate) => gate.outputs), ...config.handoffs.flatMap((handoff) => handoff.outputs)];
  for (const output of new Set(claimed)) if (!declared.has(output)) diagnostics.push({ kind: "undeclared_output", stage_key, session_role, contract_item: output, output });
  for (const output of declared_outputs) {
    const producers = config.role_configs.filter((role) => role.authorized_outputs.includes(output)).length;
    if (producers !== 1) diagnostics.push({ kind: "output_producer_count", stage_key, session_role, contract_item: output, output, producers });
  }
  return diagnostics;
};
