import { z } from "zod";

import { err, ok, type Result } from "../domain/primitives";
import type { WorkflowDefinitionId } from "../domain/primitives";
import type { FanOutDefinition } from "../domain/delegated-session";
import type { InputSlot, WorkflowDefinition } from "../domain/workflow";
import { delegatedSessionDefinitionSchema } from "./delegated-session";

const inputSlotSchema = z.object({
  name: z.string().min(1),
  artifact_type: z.string().min(1),
  optional: z.boolean().default(false),
  collect: z.boolean().default(false),
  delivery: z.enum(["producer_complete", "unit_complete"]).default("producer_complete"),
});

const outputSlotSchema = z.object({ name: z.string().min(1), artifact_type: z.string().min(1) });
const endpointSchema = z.object({ stage: z.string().min(1), slot: z.string().min(1) });
const stageSchema = z.object({
  stage_type: z.string().min(1),
  operator_role: z.enum(["spec", "plan", "brief", "build", "assessment", "final_integration"]).nullable().optional().transform((value) => value ?? null),
  config: z.json(),
  inputs: z.array(inputSlotSchema),
  outputs: z.array(outputSlotSchema),
});

const workflowDefinitionSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  version: z.number().int().positive(),
  graph: z.object({
    stages: z.record(z.string(), stageSchema),
    edges: z.array(z.object({ from: endpointSchema, to: endpointSchema })),
  }),
  created_at: z.iso.datetime({ offset: true }),
  archived: z.boolean().default(false),
});

export interface DefinitionValidationError {
  readonly operation: "parse_workflow_definition" | "validate_workflow_graph";
  readonly detail: string;
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
    let fanOut: FanOutDefinition | null = null;
    if (stage.stage_type === "delegated_session") {
      const config = delegatedSessionDefinitionSchema.safeParse(stage.config);
      if (!config.success) return err({ operation: "validate_workflow_graph", detail: `stage '${stageKey}' config invalid: ${z.prettifyError(config.error)}` });
      const terminalOutput = config.data.gate_output ?? config.data.output_gate?.output ?? config.data.output_handoff?.output;
      if (terminalOutput && !stage.outputs.some((output) => output.name === terminalOutput)) {
        return err({ operation: "validate_workflow_graph", detail: `stage '${stageKey}' terminal output '${terminalOutput}' is not declared` });
      }
      fanOut = config.data.fan_out ?? null;
    }
    const violation = selectIncrementalInputViolation(stageKey, stage.inputs, fanOut);
    if (violation) return err({ operation: "validate_workflow_graph", detail: violation });
  }
  for (const edge of definition.graph.edges) {
    const producer = definition.graph.stages[edge.from.stage];
    const consumer = definition.graph.stages[edge.to.stage];
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

export const parseWorkflowDefinition = (input: unknown): Result<WorkflowDefinition, DefinitionValidationError> => {
  const parsed = workflowDefinitionSchema.safeParse(input);
  if (!parsed.success) return err({ operation: "parse_workflow_definition", detail: z.prettifyError(parsed.error) });
  const definition: WorkflowDefinition = {
    ...parsed.data,
    id: parsed.data.id as WorkflowDefinitionId,
  };
  return validateGraphReferences(definition);
};
