import { z } from "zod";
import { BUILT_IN_GATE_DISPOSITIONS, isBuiltInGateAction } from "../domain/gates";
import type { DelegatedSessionDefinitionConfig, SessionLaunchReason } from "../domain/delegated-session";
import type { StageOperatorRole } from "../domain/workflow";

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

const roleSchema = z.enum(["spec", "plan", "brief", "build", "assessment", "final_integration"]);
const launchReasonSchema = z.enum(["initial", "operator_retry", "input_revision"]);

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
    inherit_worktree_from: z.string().optional(),
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
});

export type DelegatedSessionDiagnostic =
  | { readonly kind: "duplicate_key"; readonly stage_key: string; readonly session_role: StageOperatorRole | null; readonly contract_item: string; readonly array: string; readonly key: string }
  | { readonly kind: "prompt_not_total"; readonly stage_key: string; readonly session_role: StageOperatorRole; readonly contract_item: string; readonly launch_reason: SessionLaunchReason; readonly matches: number }
  | { readonly kind: "gate_without_closer"; readonly stage_key: string; readonly session_role: StageOperatorRole | null; readonly contract_item: string; readonly gate: string }
  | { readonly kind: "output_producer_count"; readonly stage_key: string; readonly session_role: StageOperatorRole | null; readonly contract_item: string; readonly output: string; readonly producers: number }
  | { readonly kind: "wait_without_closing_event"; readonly stage_key: string; readonly session_role: StageOperatorRole | null; readonly contract_item: string; readonly wait: string }
  | { readonly kind: "unbound_placeholder"; readonly stage_key: string; readonly session_role: StageOperatorRole; readonly contract_item: string; readonly placeholder: string }
  | { readonly kind: "undeclared_output"; readonly stage_key: string; readonly session_role: StageOperatorRole | null; readonly contract_item: string; readonly output: string }
  | { readonly kind: "unavailable_tool"; readonly stage_key: string; readonly session_role: StageOperatorRole; readonly contract_item: string; readonly tool: string }
  | { readonly kind: "automated_assessment_transition"; readonly stage_key: string; readonly session_role: StageOperatorRole | null; readonly contract_item: string; readonly trigger: string };

const LAUNCH_REASONS: readonly SessionLaunchReason[] = ["initial", "operator_retry", "input_revision"];

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

/** Steps 3–5: totality, contract bindings, and executor capability. */
export const validateDelegatedSessionContracts = (
  stage_key: string,
  session_role: StageOperatorRole | null,
  declared_outputs: readonly string[],
  config: DelegatedSessionDefinitionConfig,
): readonly DelegatedSessionDiagnostic[] => {
  const diagnostics: DelegatedSessionDiagnostic[] = [];
  for (const roleConfig of config.role_configs) {
    for (const launch_reason of LAUNCH_REASONS) {
      const matches = config.prompt_matrix.filter((entry) => entry.session_role === roleConfig.session_role && entry.launch_reason === launch_reason).length;
      if (matches !== 1) diagnostics.push({ kind: "prompt_not_total", stage_key, session_role: roleConfig.session_role,
        contract_item: `${roleConfig.session_role}:${launch_reason}`, launch_reason, matches });
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
