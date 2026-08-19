import { parseWorkflowDefinition } from "../validation/workflow-definition";
import type { DefinitionValidationError } from "../validation/workflow-definition";
import type { Result } from "../domain/primitives";
import type { WorkflowDefinition } from "../domain/workflow";

/**
 * v12 adds the `provision_refs` stage and routes the build stage's repository
 * lookups through the artifact it produces.
 *
 * A new version rather than an edit to v11: definitions are immutable per
 * name and version, so changing v11's graph in place makes seeding throw on any
 * database that already holds it — and runs still in flight against v11 must
 * keep compiling the graph they were launched with.
 */
export const loadDevFlowV12 = async (): Promise<Result<WorkflowDefinition, DefinitionValidationError>> => {
  const source = await Bun.file(new URL("../../../oakridge-core/examples/dev_flow_v12.json", import.meta.url)).json();
  return parseWorkflowDefinition(source);
};
