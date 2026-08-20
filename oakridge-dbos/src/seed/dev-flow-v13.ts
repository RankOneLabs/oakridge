import { parseWorkflowDefinition } from "../validation/workflow-definition";
import type { DefinitionValidationError } from "../validation/workflow-definition";
import type { Result } from "../domain/primitives";
import type { WorkflowDefinition } from "../domain/workflow";

/**
 * v13 gives every branch role one name, and makes the planning stages declare
 * the refs they were quietly assuming.
 *
 * The four planning stages took their working directory from
 * `/repositories/0/path` — a positional index into the run context, resolved
 * with no guarantee that anything had provisioned the repository it names. They
 * declare `repository_refs` as an input now, so graph order is what guarantees
 * it, and resolve the directory through that artifact.
 *
 * `base_branch` also moved: it is one pointer beside the repositories rather
 * than a field inside each of them, because an epic builds on exactly one
 * branch. The build stage's `EXPECTED_PR_BASE` reads it, and `EXPECTED_FINAL_BASE`
 * now reads `integration_branch` — the two used to be `epic_branch` and
 * `base_branch`, which is how the same word came to mean two branches.
 *
 * A new version rather than an edit to v12: definitions are immutable per name
 * and version, so changing v12's graph in place makes seeding throw on any
 * database that already holds it — and runs still in flight against v12 must
 * keep compiling the graph they were launched with.
 */
const SOURCE = new URL("../../../oakridge-core/examples/dev_flow_v13.json", import.meta.url);

export const loadDevFlowV13 = async (): Promise<Result<WorkflowDefinition, DefinitionValidationError>> => {
  // The IO boundary. A missing or unparseable file is the same kind of answer as
  // an invalid definition — the seed cannot produce one — and the signature
  // already promises a `Result`, so it should not also throw.
  let source: unknown;
  try {
    source = await Bun.file(SOURCE).json();
  } catch (error) {
    return { ok: false, error: { operation: "parse_workflow_definition",
      detail: `built-in dev-flow v13 could not be read from ${SOURCE.pathname}: ${error instanceof Error ? error.message : String(error)}` } };
  }
  return parseWorkflowDefinition(source);
};
