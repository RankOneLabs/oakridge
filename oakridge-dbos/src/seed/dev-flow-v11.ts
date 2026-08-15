import { parseWorkflowDefinition } from "../validation/workflow-definition";
import type { DefinitionValidationError } from "../validation/workflow-definition";
import type { Result } from "../domain/primitives";
import type { WorkflowDefinition } from "../domain/workflow";

export const loadDevFlowV11 = async (): Promise<Result<WorkflowDefinition, DefinitionValidationError>> => {
  const source = await Bun.file(new URL("../../../oakridge-core/examples/dev_flow_v11.json", import.meta.url)).json();
  return parseWorkflowDefinition(source);
};
