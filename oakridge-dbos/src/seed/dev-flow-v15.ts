import { parseV15WorkflowDefinition, type V15DefinitionError } from "../validation/v15-definition";
import { err, type Result } from "../domain/primitives";
import type { WorkflowDefinition } from "../domain/dev-flow-v15";

const SOURCE = new URL("../../../workflow-config/definitions/dev_flow_v15.json", import.meta.url);

/** The built-in is the canonical six-stage contract, with no graph conversion. */
export const loadDevFlowV15 = async (): Promise<Result<WorkflowDefinition, V15DefinitionError>> => {
  let source: unknown;
  try { source = await Bun.file(SOURCE).json(); }
  catch (error) {
    return err({ operation: "validate_v15_definition", kind: "invalid_shape", path: SOURCE.pathname,
      detail: error instanceof Error ? error.message : String(error) });
  }
  return parseV15WorkflowDefinition(source);
};
