import { z } from "zod";

const slotBindingSchema = z.discriminatedUnion("from", [
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
]);

const bindableSchema = z.union([z.string(), slotBindingSchema]);
const outputGateSchema = z.object({
  output: z.string().min(1),
  steps: z.array(z.object({
    type: z.enum(["artifact_approval", "merge_confirmation"]),
    actions: z.array(z.string().min(1)).min(1),
  })).min(1),
  requires_zero_open_review_items: z.boolean().default(false),
  revision_target: z.enum(["self_stage", "upstream_handoff"]).default("self_stage"),
}).superRefine((gate, context) => {
  const seen = new Set<string>();
  for (const step of gate.steps) {
    if (seen.has(step.type)) context.addIssue({ code: "custom", message: `output_gate step type '${step.type}' must be unique` });
    seen.add(step.type);
  }
});

export const delegatedSessionDefinitionSchema = z.object({
  runtime: bindableSchema,
  prompt_template_path: z.string().min(1),
  slot_bindings: z.record(z.string(), slotBindingSchema),
  workdir: slotBindingSchema,
  session_name: z.string().min(1),
  model: bindableSchema.optional(),
  effort: bindableSchema.optional(),
  worktree: z.object({ branchName: z.string(), worktreeSubdir: z.string(), baseRef: z.string().optional() }).optional(),
  pre_authorized_tools: z.array(z.string()).default([]),
  yolo: z.boolean().default(false),
  fan_out: z.object({
    over: slotBindingSchema,
    unit_id_path: z.string().min(1),
    session_mode: z.enum(["per_unit", "shared"]).default("per_unit"),
    depends_on_path: z.string().nullable().optional(),
    max_parallel: z.number().int().positive().default(8),
    manual_admission: z.boolean().default(false),
    item_bindings: z.record(z.string(), slotBindingSchema).default({}),
    workdir: slotBindingSchema.optional(),
    worktree: z.object({ branch_name: bindableSchema, worktree_subdir: bindableSchema, base_ref: bindableSchema.optional() }).optional(),
    inherit_worktree_from: z.string().optional(),
  }).optional(),
  artifacts: z.object({ over: slotBindingSchema, id_path: z.string().min(1) }).optional(),
  gate_output: z.string().optional(),
  output_gate: outputGateSchema.optional(),
  output_handoff: z.object({
    output: z.string().min(1),
    downstream_role: z.enum(["spec", "plan", "brief", "build", "assessment", "final_integration"]),
    approved_wait: z.object({ kind: z.string().min(1) }),
  }).optional(),
}).superRefine((config, context) => {
  if (config.fan_out && config.artifacts) context.addIssue({ code: "custom", message: "fan_out and artifacts are mutually exclusive" });
  // A unit either cuts its own worktree or inherits an upstream one. Sending
  // both downstream is rejected by kbbl at session-ensure time (400), so catch
  // the authoring mistake here rather than mid-stage.
  if (config.fan_out?.worktree && config.fan_out.inherit_worktree_from) context.addIssue({ code: "custom", message: "fan_out.worktree and fan_out.inherit_worktree_from are mutually exclusive" });
  const terminalPolicies = [config.gate_output, config.output_gate, config.output_handoff].filter(Boolean);
  if (terminalPolicies.length > 1) context.addIssue({ code: "custom", message: "gate_output, output_gate, and output_handoff are mutually exclusive" });
});
