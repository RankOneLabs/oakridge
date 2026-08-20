import type { WorkflowDefinitionRepository } from "../storage/repositories";
import { loadDevFlowV13 } from "./dev-flow-v13";

export const seedBuiltins = async (repository: WorkflowDefinitionRepository): Promise<void> => {
  const definition = await loadDevFlowV13();
  if (!definition.ok) throw new Error(`built-in dev-flow v13 is invalid: ${definition.error.detail}`);
  await repository.insert_immutable(definition.value);
};
