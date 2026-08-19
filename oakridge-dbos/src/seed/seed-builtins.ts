import type { WorkflowDefinitionRepository } from "../storage/repositories";
import { loadDevFlowV12 } from "./dev-flow-v12";

export const seedBuiltins = async (repository: WorkflowDefinitionRepository): Promise<void> => {
  const definition = await loadDevFlowV12();
  if (!definition.ok) throw new Error(`built-in dev-flow v12 is invalid: ${definition.error.detail}`);
  await repository.insert_immutable(definition.value);
};
