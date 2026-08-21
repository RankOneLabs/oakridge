import type { WorkflowDefinitionRepository } from "../storage/repositories";
import { loadDevFlowV14 } from "./dev-flow-v14";

export const seedBuiltins = async (repository: WorkflowDefinitionRepository): Promise<void> => {
  const definition = await loadDevFlowV14();
  if (!definition.ok) throw new Error(`built-in dev-flow v14 is invalid: ${definition.error.detail}`);
  await repository.insert_immutable(definition.value);
};
