import type { WorkflowDefinitionRepository } from "../storage/repositories";
import { loadDevFlowV11 } from "./dev-flow-v11";

export const seedBuiltins = async (repository: WorkflowDefinitionRepository): Promise<void> => {
  const definition = await loadDevFlowV11();
  if (!definition.ok) throw new Error(`built-in dev-flow v11 is invalid: ${definition.error.detail}`);
  await repository.insert_immutable(definition.value);
};
