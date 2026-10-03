/** Test-only input for the machine/storage boundaries removed by later cohorts.
 * The production v15 loader always reads the canonical six-stage definition.
 */
import { parseWorkflowDefinition } from "../../src/validation/workflow-definition";
import { createDevFlowAdapterRegistry } from "../../src/adapters/dev-flow";

export const loadGraphDefinitionFixture = async () => parseWorkflowDefinition(
  await Bun.file(new URL("./graph-definition-fixture.json", import.meta.url)).json(),
  createDevFlowAdapterRegistry(),
);
