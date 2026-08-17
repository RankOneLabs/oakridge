import type { CompiledEdge, CompiledGateStep, CompiledOutputContract, CompiledStageContract, CompiledWorkflowDefinition, MaterializationContract, OutputReleaseContract } from "../domain/compiled-workflow";
import type { DelegatedSessionDefinitionConfig } from "../domain/delegated-session";
import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import type { StageNodeDefinition, WorkflowDefinition } from "../domain/workflow";
import { delegatedSessionDefinitionSchema } from "../validation/delegated-session";
import { selectBuiltInGateDisposition } from "../domain/gates";
import { readOwn } from "../domain/records";

export interface CompileWorkflowError {
  readonly operation: "compile_workflow";
  readonly stage_key: string | null;
  readonly detail: string;
}

export interface StageTypeCompilation {
  readonly definition_config: DelegatedSessionDefinitionConfig | JsonValue;
  readonly materialization: MaterializationContract;
  output_release(output_name: string): OutputReleaseContract;
}

export interface StageTypeCompiler {
  compile(stage_key: string, config: JsonValue): Result<StageTypeCompilation, CompileWorkflowError>;
}

/**
 * Resolve a step's declared action names to their dispositions. Definition
 * validation has already rejected any name without one, so this is total.
 */
const compileGateStep = (step: { readonly type: string; readonly actions: readonly string[] }): CompiledGateStep =>
  ({ type: step.type, actions: step.actions.map((name) => ({ name, disposition: selectBuiltInGateDisposition(name) })) });

const outputRelease = (outputName: string, config: DelegatedSessionDefinitionConfig): OutputReleaseContract => {
  if (config.output_gate?.output === outputName) return {
    kind: "gate",
    steps: config.output_gate.steps.map(compileGateStep),
    requires_zero_open_review_items: config.output_gate.requires_zero_open_review_items ?? false,
    revision_target: config.output_gate.revision_target ?? "self_stage",
  };
  if (config.gate_output === outputName) return {
    kind: "gate",
    steps: [{ type: "artifact_approval", actions: ["approve", "request_revision"] }, { type: "merge_confirmation", actions: ["confirm_merged", "closed_without_merge"] }].map(compileGateStep),
    requires_zero_open_review_items: true,
    revision_target: "self_stage",
  };
  if (config.output_handoff?.output === outputName) return {
    kind: "handoff",
    downstream_role: config.output_handoff.downstream_role,
    external_wait_kind: config.output_handoff.approved_wait.kind,
  };
  return { kind: "immediate" };
};

const materialization = (config: DelegatedSessionDefinitionConfig): MaterializationContract => {
  if (config.artifacts) return { kind: "artifact_collection", over: config.artifacts.over, id_path: config.artifacts.id_path };
  if (config.fan_out) return {
    kind: "fan_out",
    over: config.fan_out.over,
    unit_id_path: config.fan_out.unit_id_path,
    depends_on_path: config.fan_out.depends_on_path ?? null,
    max_parallel: config.fan_out.max_parallel ?? 8,
    manual_admission: config.fan_out.manual_admission ?? false,
  };
  return { kind: "scalar" };
};

export const delegatedSessionStageTypeCompiler: StageTypeCompiler = {
  compile(stageKey, rawConfig) {
  const parsed = delegatedSessionDefinitionSchema.safeParse(rawConfig);
  if (!parsed.success) return err({ operation: "compile_workflow", stage_key: stageKey, detail: parsed.error.message });
  const config = parsed.data as DelegatedSessionDefinitionConfig;
  return ok({
    definition_config: config,
    materialization: materialization(config),
    output_release: (outputName) => outputRelease(outputName, config),
  });
  },
};

export type StageTypeCompilerRegistry = Readonly<Record<string, StageTypeCompiler>>;

export const builtInStageTypeCompilers: StageTypeCompilerRegistry = {
  delegated_session: delegatedSessionStageTypeCompiler,
};

const compileStage = (stageKey: string, node: StageNodeDefinition, registry: StageTypeCompilerRegistry): Result<CompiledStageContract, CompileWorkflowError> => {
  const compiler = registry[node.stage_type];
  if (!compiler) return err({ operation: "compile_workflow", stage_key: stageKey, detail: `unregistered stage type '${node.stage_type}'` });
  const compiledConfig = compiler.compile(stageKey, node.config);
  if (!compiledConfig.ok) return compiledConfig;
  const outputs: readonly CompiledOutputContract[] = node.outputs.map((output) => ({ ...output, release: compiledConfig.value.output_release(output.name) }));
  return ok({
    stage_key: stageKey,
    stage_type: node.stage_type,
    operator_role: node.operator_role,
    inputs: node.inputs,
    outputs,
    materialization: compiledConfig.value.materialization,
    executor: { executor_type: node.stage_type, definition_config: compiledConfig.value.definition_config },
  });
};

export const compileWorkflowDefinition = (definition: WorkflowDefinition, registry: StageTypeCompilerRegistry = builtInStageTypeCompilers): Result<CompiledWorkflowDefinition, CompileWorkflowError> => {
  const stages: Record<string, CompiledStageContract> = {};
  for (const [stageKey, node] of Object.entries(definition.graph.stages)) {
    const compiled = compileStage(stageKey, node, registry);
    if (!compiled.ok) return compiled;
    stages[stageKey] = compiled.value;
  }
  const edges: CompiledEdge[] = definition.graph.edges.map((edge) => {
    const consumer = readOwn(stages, edge.to.stage);
    const input = consumer?.inputs.find((candidate) => candidate.name === edge.to.slot);
    if (!input) throw new Error(`validated edge input disappeared: ${edge.to.stage}.${edge.to.slot}`);
    return { producer_stage: edge.from.stage, producer_output: edge.from.slot, consumer_stage: edge.to.stage, consumer_input: edge.to.slot, delivery: input.delivery };
  });
  const blockedByRequiredEdge = new Set(edges.filter((edge) => !readOwn(stages, edge.consumer_stage)?.inputs.find((input) => input.name === edge.consumer_input)?.optional).map((edge) => edge.consumer_stage));
  const source_stages = Object.keys(stages).filter((stageKey) => !blockedByRequiredEdge.has(stageKey)).sort();
  return ok({ stages, edges, source_stages });
};
