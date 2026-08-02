import { stageFormEntryToNodeDef, type StageFormEntry } from "../authoring/stage-form";
import type { EdgeDef, WorkflowDefFull, WorkflowGraph } from "../types";
import type { Result } from "../../lib/result";

export interface WorkflowDefinitionFormState {
  stages: StageFormEntry[];
  edges: EdgeDef[];
}

export interface WorkflowDefinitionValidationInput {
  name: string;
  stages: StageFormEntry[];
  edges: EdgeDef[];
}

export interface WorkflowDefinitionValidationError {
  operation: "validate_workflow_definition";
  entityId: string;
  details: string[];
}

export function validateWorkflowDefinition({ name, stages, edges }: WorkflowDefinitionValidationInput): Result<null, WorkflowDefinitionValidationError> {
  const errors: string[] = [];
  if (!name.trim()) errors.push("Name is required.");
  const stageKeys = new Set<string>();
  for (const stage of stages) {
    if (!stage.stageKey.trim()) errors.push("Each stage must have a non-empty key.");
    else if (stageKeys.has(stage.stageKey)) errors.push(`Duplicate stage key: "${stage.stageKey}".`);
    else stageKeys.add(stage.stageKey);
  }
  for (const edge of edges) {
    if (!edge.from.stage || !edge.to.stage) errors.push("Each edge must have a from/to stage.");
    else {
      if (!stageKeys.has(edge.from.stage)) errors.push(`Edge references unknown from-stage: "${edge.from.stage}".`);
      if (!stageKeys.has(edge.to.stage)) errors.push(`Edge references unknown to-stage: "${edge.to.stage}".`);
      if (!edge.from.slot) errors.push(`Edge from "${edge.from.stage}" — from-slot must not be empty.`);
      if (!edge.to.slot) errors.push(`Edge to "${edge.to.stage}" — to-slot must not be empty.`);
    }
    const fromStage = stages.find((stage) => stage.stageKey === edge.from.stage);
    const toStage = stages.find((stage) => stage.stageKey === edge.to.stage);
    if (fromStage && edge.from.slot && !fromStage.outputs.some((output) => output.name === edge.from.slot)) errors.push(`Edge from "${edge.from.stage}.${edge.from.slot}" — slot not declared in that stage's outputs.`);
    if (toStage && edge.to.slot && !toStage.inputs.some((input) => input.name === edge.to.slot)) errors.push(`Edge to "${edge.to.stage}.${edge.to.slot}" — slot not declared in that stage's inputs.`);
  }
  return errors.length === 0
    ? { ok: true, value: null }
    : {
        ok: false,
        error: {
          operation: "validate_workflow_definition",
          entityId: name.trim() || "new_workflow_definition",
          details: errors,
        },
      };
}

export function buildWorkflowGraph(stages: StageFormEntry[], edges: EdgeDef[]): WorkflowGraph {
  const stageMap: WorkflowGraph["stages"] = {};
  for (const stage of stages) stageMap[stage.stageKey] = stageFormEntryToNodeDef(stage);
  return { stages: stageMap, edges };
}

export function workflowDefinitionToFormState(definition: WorkflowDefFull): WorkflowDefinitionFormState {
  const stages = Object.entries(definition.graph.stages).map(([stageKey, node]) => ({
    _uid: crypto.randomUUID(), stageKey, inputs: node.inputs, outputs: node.outputs,
    config: {
      runtime: node.config.runtime ?? "claude-code",
      prompt_template_path: node.config.prompt_template_path ?? "",
      slot_bindings: node.config.slot_bindings ?? {},
      workdir: node.config.workdir ?? { from: "context" as const, path: "/workdir" },
      session_name: node.config.session_name ?? "",
      model: node.config.model ?? null, effort: node.config.effort ?? null,
      worktree: node.config.worktree ?? null,
      pre_authorized_tools: node.config.pre_authorized_tools ?? [], yolo: node.config.yolo ?? false,
      fan_out: node.config.fan_out ?? null, gate_output: node.config.gate_output ?? null,
    },
  }));
  return { stages, edges: definition.graph.edges };
}
