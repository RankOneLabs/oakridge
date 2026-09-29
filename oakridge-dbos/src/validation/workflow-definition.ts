import { z } from "zod";

import { err, ok, type Result } from "../domain/primitives";
import type { WorkflowDefinitionId } from "../domain/primitives";
import type { FanOutDefinition } from "../domain/delegated-session";
import type { InputSlot, WorkflowDefinition } from "../domain/workflow";
import { delegatedSessionDefinitionSchema, legacyHandoffRoleOf, legacyRevisionPolicyOf, normalizeDelegatedSessionDefinition } from "./delegated-session";
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
const stageSchema = z.object({
  stage_type: z.string().min(1),
  operator_role: z.string().min(1).nullable().optional().transform((value) => value ?? null),
  config: z.json(),
  inputs: z.array(inputSlotSchema),
  outputs: z.array(outputSlotSchema),
});

const workflowDefinitionSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Invalid UUID"),
  name: z.string().min(1),
  version: z.number().int().positive(),
  graph: z.object({
    stages: z.record(z.string(), stageSchema),
    edges: z.array(z.object({ from: endpointSchema, to: endpointSchema })),
    transitions: z.array(z.object({
      trigger: z.object({ kind: z.enum(["stage_output", "assessment_outcome", "operator"]), stage: z.string().min(1), item: z.string().min(1) }),
      launch: z.object({ stage: z.string().min(1), session_role: z.string().min(1),
        launch_reason: z.enum(["initial", "operator_retry", "input_revision"]) }),
    })).optional(),
  }),
  created_at: z.iso.datetime({ offset: true }),
  archived: z.boolean().default(false),
});

const legacyRoleForStage = (stageKey: string): import("../domain/workflow").StageOperatorRole | null => ({
  spec_analyzer: "spec", plan_writer: "plan", brief_writer: "brief", build: "build", assessor: "assessment", final_integration: "final_integration",
} as const)[stageKey as "spec_analyzer" | "plan_writer" | "brief_writer" | "build" | "assessor" | "final_integration"] ?? null;

export interface DefinitionValidationError {
  readonly operation: "parse_workflow_definition" | "validate_workflow_graph";
  readonly detail: string;
}

export interface AdapterRoleRegistry {
  has_role(name: string): boolean;
}

/**
 * A `unit_complete` input is delivered one artifact at a time as its producer
 * releases each unit. Several inputs may arrive that way — dev-flow's assessor
 * takes both `build_result` and `brief` — but units are minted only from the
 * input the stage fans out `over`; the rest accumulate and feed those units.
 *
 * That leaves two shapes with no meaning at all, both of which strand the run
 * at runtime rather than reporting anything: a stage that consumes incremental
 * input without fanning out fails on the first artifact, and a fan-out driven
 * by a non-input binding has nothing to mint units from, so it waits forever.
 * Rejecting them here keeps the failure at definition time, where an operator
 * can still fix it.
 */
const selectIncrementalInputViolation = (stageKey: string, inputs: readonly InputSlot[], fanOut: FanOutDefinition | null): string | null => {
  const incremental = inputs.filter((slot) => slot.delivery === "unit_complete");
  const first = incremental[0];
  if (!first) return null;
  if (!fanOut) return `stage '${stageKey}' consumes incremental input '${first.name}' but does not fan out`;
  if (fanOut.over.from !== "input") return `stage '${stageKey}' fans out over a '${fanOut.over.from}' binding, so incremental input '${first.name}' drives nothing`;
  return null;
};

const validateGraphReferences = (definition: WorkflowDefinition): Result<WorkflowDefinition, DefinitionValidationError> => {
  for (const [stageKey, stage] of Object.entries(definition.graph.stages)) {
    // A unit is discharged only by releasing its required outputs, so a stage
    // with none has no completion condition: `derive` would mark its unit
    // satisfied on the first ask and the run would succeed without the
    // executor ever running. Refuse the shape where an operator can fix it.
    if (stage.outputs.length === 0) {
      return err({ operation: "validate_workflow_graph", detail: `stage '${stageKey}' must declare at least one output` });
    }
    let fanOut: FanOutDefinition | null = null;
    if (stage.stage_type === "delegated_session") {
      const config = delegatedSessionDefinitionSchema.safeParse(stage.config);
      if (!config.success) return err({ operation: "validate_workflow_graph", detail: `stage '${stageKey}' config invalid: ${z.prettifyError(config.error)}` });
      const terminalOutputs = [...config.data.gates.flatMap((gate) => gate.outputs), ...config.data.handoffs.flatMap((handoff) => handoff.outputs)];
      const terminalOutput = terminalOutputs.find((name) => !stage.outputs.some((output) => output.name === name));
      if (terminalOutput) {
        return err({ operation: "validate_workflow_graph", detail: `stage '${stageKey}' terminal output '${terminalOutput}' is not declared` });
      }
      fanOut = config.data.fan_out ?? null;
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
    const violation = selectIncrementalInputViolation(stageKey, stage.inputs, fanOut);
    if (violation) return err({ operation: "validate_workflow_graph", detail: violation });
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
  const legacyTransitions = Object.entries(parsed.data.graph.stages).flatMap(([stageKey, stage]) => {
    const policy = stage.stage_type === "delegated_session" ? legacyRevisionPolicyOf(stage.config) : null;
    const stageRole = stage.operator_role ?? legacyRoleForStage(stageKey);
    if (!policy || stageRole === null) return [];
    const launchStage = policy.target === "self_stage" ? stageKey : Object.entries(parsed.data.graph.stages)
      .find(([, candidate]) => legacyHandoffRoleOf(candidate.config) === stageRole)?.[0];
    const launchNode = launchStage ? parsed.data.graph.stages[launchStage] : undefined;
    const launchRole = launchStage && launchNode ? launchNode.operator_role ?? legacyRoleForStage(launchStage) : null;
    if (!launchStage || !launchRole) return [];
    return [{ trigger: { kind: "operator" as const, stage: stageKey, item: policy.action },
      launch: { stage: launchStage, session_role: launchRole, launch_reason: "input_revision" as const } }];
  });
  const transitions = [...(parsed.data.graph.transitions ?? []), ...legacyTransitions];
  const definition: WorkflowDefinition = {
    ...parsed.data,
    graph: { ...parsed.data.graph, stages: Object.fromEntries(Object.entries(parsed.data.graph.stages).map(([stageKey, stage]) => [stageKey,
      stage.stage_type === "delegated_session" ? { ...stage, operator_role: stage.operator_role ?? legacyRoleForStage(stageKey),
        config: normalizeDelegatedSessionDefinition(stage.config, stage.operator_role ?? legacyRoleForStage(stageKey), stage.outputs.map((output) => output.name)) }
        : stage.stage_type === PROVISION_REPOSITORY_REFS_STAGE_TYPE && typeof stage.config === "object" && stage.config !== null && !Array.isArray(stage.config)
          && !("base_branch" in stage.config) ? { ...stage, config: { ...stage.config, base_branch: { from: "context", path: "/base_branch" } } } : stage])),
      ...(transitions.length > 0 ? { transitions } : {}) },
    id: parsed.data.id as WorkflowDefinitionId,
  };
  const graph = validateGraphReferences(definition);
  if (!graph.ok) return graph;
  return validateRegisteredRoles(graph.value, adapter_roles);
};
