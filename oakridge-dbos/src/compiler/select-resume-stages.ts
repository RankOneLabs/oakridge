import type { CompiledWorkflowDefinition } from "../domain/compiled-workflow";

export const selectAncestorStages = (definition: CompiledWorkflowDefinition, stage_key: string): readonly string[] => {
  if (!definition.stages[stage_key]) throw new Error(`resume stage '${stage_key}' does not exist`);
  const ancestors = new Set<string>();
  const visit = (consumer: string): void => {
    for (const edge of definition.edges.filter((candidate) => candidate.consumer_stage === consumer)) {
      if (ancestors.has(edge.producer_stage)) continue;
      ancestors.add(edge.producer_stage);
      visit(edge.producer_stage);
    }
  };
  visit(stage_key);
  return [...ancestors].sort();
};
