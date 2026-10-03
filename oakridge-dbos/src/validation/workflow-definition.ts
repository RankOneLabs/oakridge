import { z } from "zod";

import { err, ok, type Result } from "../domain/primitives";
import type { WorkflowDefinitionId } from "../domain/primitives";
import type { MachineDefinition } from "../domain/stage-machine";
import type { WorkflowDefinition } from "../domain/workflow";
import { delegatedSessionDefinitionSchema } from "./delegated-session";
import { repositoryProvisioningDefinitionSchema } from "./repository-provisioning";
import { PROVISION_REPOSITORY_REFS_STAGE_TYPE, REPOSITORY_REFS_ARTIFACT_TYPE } from "../domain/repository-refs";
import { readOwn } from "../domain/records";

const inputSlotSchema = z.object({
  name: z.string().min(1),
  artifact_type: z.string().min(1),
  optional: z.boolean().default(false),
  collect: z.boolean().default(false),
  delivery: z.enum(["producer_complete", "unit_complete"]).default("producer_complete"),
});

const outputSlotSchema = z.object({
  name: z.string().min(1),
  artifact_type: z.string().min(1),
  attention: z.enum(["required", "optional", "none"]).optional(),
});
const endpointSchema = z.object({ stage: z.string().min(1), slot: z.string().min(1) });
const eventMatchSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("started") }),
  z.object({ event: z.literal("artifact_published"), output: z.string().min(1) }),
  z.object({ event: z.literal("gate_decided"), gate: z.string().min(1), action: z.string().min(1) }),
  z.object({ event: z.literal("session_ended") }),
  z.object({ event: z.literal("operator_retry") }),
  z.object({ event: z.literal("operator_abandon") }),
  z.object({ event: z.literal("cancel") }),
  z.object({ event: z.literal("external_observed"), source: z.string().min(1) }),
]);
const stateSchema = z.object({
  status: z.enum(["pending", "active", "blocked", "complete", "failed", "cancelled"]),
  blocked_reason: z.enum(["dependency", "gate", "capacity", "external", "operator", "retry"]).nullable(),
  next_actor: z.enum(["core", "agent", "service", "operator", "external"]).nullable(),
  session_role: z.string().nullable(),
}).superRefine((state, context) => {
  if ((state.status === "blocked") !== (state.blocked_reason !== null)) context.addIssue({ code: "custom", message: "blocked_reason must be set iff status is blocked" });
  if ((["complete", "failed", "cancelled"].includes(state.status)) !== (state.next_actor === null)) context.addIssue({ code: "custom", message: "next_actor must be null iff status is terminal" });
});
export const machineDefinitionSchema = z.object({
  initial: z.string().min(1),
  states: z.record(z.string(), stateSchema),
  transitions: z.array(z.union([
    z.object({ from: z.union([z.string().min(1), z.object({ any_nonterminal: z.literal(true) })]), on: eventMatchSchema,
      guard: z.object({ name: z.string().min(1), negate: z.boolean().default(false), args: z.record(z.string(), z.json()).default({}) }).nullable().default(null),
      to: z.string().min(1), effects: z.array(z.object({ name: z.string().min(1), args: z.record(z.string(), z.json()).default({}) })).default([]) }),
    z.object({ from: z.union([z.string().min(1), z.object({ any_nonterminal: z.literal(true) })]), on: eventMatchSchema,
      guard: z.object({ name: z.string().min(1), negate: z.boolean().default(false), args: z.record(z.string(), z.json()).default({}) }).nullable().default(null),
      refuse: z.string().min(1) }),
  ])),
});
export const machineDefinitionsSchema = z.record(z.string(), machineDefinitionSchema);
const stageSchema = z.object({
  stage_type: z.string().min(1),
  operator_role: z.string().min(1).nullable().optional().transform((value) => value ?? null),
  config: z.json(),
  inputs: z.array(inputSlotSchema),
  outputs: z.array(outputSlotSchema),
}).superRefine((stage, context) => {
  if (stage.stage_type === "delegated_session" && stage.operator_role === null) {
    context.addIssue({ code: "custom", path: ["operator_role"], message: "delegated_session requires operator_role" });
  }
});

const workflowDefinitionSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Invalid UUID"),
  name: z.string().min(1),
  version: z.number().int().positive(),
  machines: machineDefinitionsSchema.optional(),
  graph: z.object({
    stages: z.record(z.string(), stageSchema),
    edges: z.array(z.object({ from: endpointSchema, to: endpointSchema })),
    transitions: z.array(z.object({
      trigger: z.object({ kind: z.enum(["stage_output", "assessment_outcome", "operator"]), stage: z.string().min(1), item: z.string().min(1) }),
      launch: z.object({ stage: z.string().min(1), session_role: z.string().min(1),
        launch_reason: z.string().min(1) }),
    })).optional(),
  }),
  created_at: z.iso.datetime({ offset: true }),
  archived: z.boolean().default(false),
});

export interface DefinitionValidationError {
  readonly operation: "parse_workflow_definition" | "validate_workflow_graph";
  readonly detail: string;
}

export interface AdapterRoleRegistry {
  has_role(name: string): boolean;
}

const validateGraphReferences = (definition: WorkflowDefinition): Result<WorkflowDefinition, DefinitionValidationError> => {
  for (const [stageKey, stage] of Object.entries(definition.graph.stages)) {
    // A unit is discharged only by releasing its required outputs, so a stage
    // with none has no completion condition: `derive` would mark its unit
    // satisfied on the first ask and the run would succeed without the
    // executor ever running. Refuse the shape where an operator can fix it.
    if (stage.outputs.length === 0) {
      return err({ operation: "validate_workflow_graph", detail: `stage '${stageKey}' must declare at least one output` });
    }
    if (stage.stage_type === "delegated_session") {
      const config = delegatedSessionDefinitionSchema.safeParse(stage.config);
      if (!config.success) return err({ operation: "validate_workflow_graph", detail: `stage '${stageKey}' config invalid: ${z.prettifyError(config.error)}` });
      const terminalOutputs = [...config.data.gates.flatMap((gate) => gate.outputs), ...config.data.handoffs.flatMap((handoff) => handoff.outputs)];
      const terminalOutput = terminalOutputs.find((name) => !stage.outputs.some((output) => output.name === name));
      if (terminalOutput) {
        return err({ operation: "validate_workflow_graph", detail: `stage '${stageKey}' terminal output '${terminalOutput}' is not declared` });
      }
    }
    if (stage.stage_type === PROVISION_REPOSITORY_REFS_STAGE_TYPE) {
      const config = repositoryProvisioningDefinitionSchema.safeParse(stage.config);
      if (!config.success) return err({ operation: "validate_workflow_graph", detail: `stage '${stageKey}' config invalid: ${z.prettifyError(config.error)}` });
      // The executor emits exactly one artifact per repository, so a second
      // declared output could never be satisfied and would strand every unit
      // waiting on it.
      if (stage.outputs.length !== 1) {
        return err({ operation: "validate_workflow_graph", detail: `stage '${stageKey}' must declare exactly one output, found ${stage.outputs.length}` });
      }
      if (stage.outputs[0]?.artifact_type !== REPOSITORY_REFS_ARTIFACT_TYPE) {
        return err({ operation: "validate_workflow_graph", detail: `stage '${stageKey}' output '${stage.outputs[0]?.name}' must have artifact type '${REPOSITORY_REFS_ARTIFACT_TYPE}'` });
      }
    }
  }
  for (const edge of definition.graph.edges) {
    const producer = readOwn(definition.graph.stages, edge.from.stage);
    const consumer = readOwn(definition.graph.stages, edge.to.stage);
    if (!producer || !consumer) {
      return err({ operation: "validate_workflow_graph", detail: `edge references unknown stage: ${edge.from.stage} -> ${edge.to.stage}` });
    }
    const output = producer.outputs.find((slot) => slot.name === edge.from.slot);
    const input = consumer.inputs.find((slot) => slot.name === edge.to.slot);
    if (!output || !input) {
      return err({ operation: "validate_workflow_graph", detail: `edge references unknown slot: ${edge.from.stage}.${edge.from.slot} -> ${edge.to.stage}.${edge.to.slot}` });
    }
    if (output.artifact_type !== input.artifact_type) {
      return err({ operation: "validate_workflow_graph", detail: `edge artifact types differ: ${output.artifact_type} -> ${input.artifact_type}` });
    }
  }
  return ok(definition);
};

const validateRegisteredRoles = (
  definition: WorkflowDefinition,
  registry: AdapterRoleRegistry,
): Result<WorkflowDefinition, DefinitionValidationError> => {
  const roles = new Set<string>();
  for (const stage of Object.values(definition.graph.stages)) {
    if (stage.operator_role) roles.add(stage.operator_role);
    if (stage.stage_type !== "delegated_session") continue;
    const config = delegatedSessionDefinitionSchema.safeParse(stage.config);
    if (!config.success) continue;
    for (const entry of config.data.prompt_matrix) roles.add(entry.session_role);
    for (const entry of config.data.role_configs) roles.add(entry.session_role);
    for (const handoff of config.data.handoffs) roles.add(handoff.downstream_role);
  }
  for (const transition of definition.graph.transitions ?? []) roles.add(transition.launch.session_role);
  const unknown = [...roles].filter((role) => !registry.has_role(role)).sort();
  return unknown.length === 0 ? ok(definition) : err({ operation: "validate_workflow_graph",
    detail: `workflow references unregistered adapter role(s): ${unknown.join(", ")}` });
};

export const parseWorkflowDefinition = (input: unknown, adapter_roles: AdapterRoleRegistry): Result<WorkflowDefinition, DefinitionValidationError> => {
  const parsed = workflowDefinitionSchema.safeParse(input);
  if (!parsed.success) return err({ operation: "parse_workflow_definition", detail: z.prettifyError(parsed.error) });
  const definition: WorkflowDefinition = {
    ...parsed.data,
    id: parsed.data.id as WorkflowDefinitionId,
    machines: parsed.data.machines as unknown as Readonly<Record<string, MachineDefinition>> | undefined,
  };
  const graph = validateGraphReferences(definition);
  if (!graph.ok) return graph;
  return validateRegisteredRoles(graph.value, adapter_roles);
};
