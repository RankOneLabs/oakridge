import type { WorkflowDefinitionRepository } from "../storage/repositories";
import type { WorkflowDefinition } from "../domain/workflow";
import { loadDevFlowV14 } from "./dev-flow-v14";

/**
 * Older versions of the built-in, which the operator should no longer be able to
 * pick.
 *
 * Seeding a new version left every earlier one in the launch list, so the form
 * offered v11 and v13 beside v14 with nothing to say which was current — and
 * picking a superseded one is not a small mistake. v11 predates the provisioning
 * stage and still takes its working directory from `/repositories/0/path`; v13
 * carries the `UNIT_ID` binding that addressed every cohort's emit at a unit
 * that does not exist. A list that offers those as equals is a trap.
 *
 * Archived, not deleted. `find_by_id` does not filter on it, so a run launched
 * against an older version still compiles the graph it was launched with, and
 * `list(true)` and the unarchive route can still reach it. Only the default
 * listing — the one the launch form reads — stops offering it.
 *
 * Strictly lower versions of the same name: a definition an operator authored
 * themselves is theirs, and a newer one is not this seed's to retire.
 */
const supersededBy = (
  current: WorkflowDefinition,
  all: readonly WorkflowDefinition[],
): readonly WorkflowDefinition[] =>
  all.filter((candidate) =>
    candidate.name === current.name && candidate.version < current.version && !candidate.archived);

export const seedBuiltins = async (repository: WorkflowDefinitionRepository): Promise<void> => {
  const definition = await loadDevFlowV14();
  if (!definition.ok) throw new Error(`built-in dev-flow v14 is invalid: ${definition.error.detail}`);
  await repository.insert_immutable(definition.value);

  // `list(true)`: an already-archived version must be visible here, or it would
  // look superseded-but-unarchived on every boot and be re-archived forever.
  const superseded = supersededBy(definition.value, await repository.list(true));
  for (const stale of superseded) await repository.set_archived(stale.id, true);
};
