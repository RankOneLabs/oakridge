import type { CompiledWorkflowDefinition } from "../domain/compiled-workflow";
import { err, ok, type Result } from "../domain/primitives";
import { hasOwn } from "../domain/records";

export interface ResumeStageSelectionError {
  readonly operation: "select_ancestor_stages";
  readonly stage_key: string;
  readonly detail: string;
}

/**
 * The stages whose output a resumed run inherits rather than recomputes.
 * Returns a `Result` like every other compiler transform: an unknown resume
 * stage is a caller mistake, and a workflow that throws on one dies without an
 * outcome instead of recording why it could not start.
 */
export const selectAncestorStages = (definition: CompiledWorkflowDefinition, stage_key: string): Result<readonly string[], ResumeStageSelectionError> => {
  if (!hasOwn(definition.stages, stage_key)) return err({ operation: "select_ancestor_stages", stage_key, detail: `resume stage '${stage_key}' does not exist` });
  const ancestors = new Set<string>();
  const visit = (consumer: string): void => {
    for (const edge of definition.edges.filter((candidate) => candidate.consumer_stage === consumer)) {
      if (ancestors.has(edge.producer_stage)) continue;
      ancestors.add(edge.producer_stage);
      visit(edge.producer_stage);
    }
  };
  visit(stage_key);
  return ok([...ancestors].sort());
};
