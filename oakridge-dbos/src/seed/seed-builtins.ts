import { resolve } from "node:path";
import type { WorkflowDefinition } from "../domain/dev-flow-v15";
import type { V15PromptBundle } from "../compiler/compile-v15";
import { compileV15WorkflowDefinition } from "../compiler/compile-v15";
import { loadDevFlowV15 } from "./dev-flow-v15";
import { createPromptTemplateLoader } from "../runtime/prompt-template";

export interface V15DefinitionSeedRepository {
  insert_v15_immutable(definition: WorkflowDefinition, prompts: V15PromptBundle): Promise<void>;
}

/** Seeds definition data only. Stage initialization belongs to boundary B4. */
export const seedBuiltins = async (repository: V15DefinitionSeedRepository): Promise<void> => {
  const definition = await loadDevFlowV15();
  if (!definition.ok) throw new Error(`built-in v15 is invalid: ${definition.error.detail}`);
  const compiled = await compileV15WorkflowDefinition(definition.value, createPromptTemplateLoader(resolve(import.meta.dir, "../../..")));
  if (!compiled.ok) throw new Error(`built-in v15 does not compile: ${compiled.error.detail}`);
  await repository.insert_v15_immutable(compiled.value.definition, compiled.value.prompts);
};
