import type { WorkflowDefinitionRepository } from "../storage/repositories";
import type { WorkflowDefinition } from "../domain/workflow";
import { loadDevFlowV15 } from "./dev-flow-v15";
import { createPromptBundle, createPromptTemplateLoader } from "../runtime/prompt-template";
import { resolve } from "node:path";

/**
 * Every dev-flow definition this seed has ever shipped.
 *
 * Matching on name and version instead was wrong in a way worth spelling out:
 * `POST /workflow_defs` puts no reservation on `name`, and a definition carries
 * no marker saying who wrote it, so an operator can author one called
 * `dev-flow` at any unused version. A name-and-version rule cannot tell that
 * apart from a built-in and would silently archive their work — the same defect
 * this file exists to clear up, pointed at the operator instead of the runtime.
 *
 * Ids can. Anything this seed has ever inserted came from a file in
 * `workflow-config/definitions`, so listing them is that knowledge made explicit, and
 * the failure mode is now the harmless direction: an id missing from this list
 * means that version keeps appearing in the launcher, never that someone else's
 * definition disappears from it.
 *
 * A new version adds its id here.
 */
const SHIPPED_DEV_FLOW_IDS: ReadonlySet<string> = new Set([
  "5a8c3d16-7e42-4f99-8b63-d2f1a6c8e307", // v15
]);

/**
 * The shipped versions this one replaces, out of the definitions currently on
 * offer.
 *
 * Seeding a new version left every earlier one in the launch list, so the form
 * offered v11 and v13 beside v14 with nothing to say which was current. Picking
 * a superseded one is not a small mistake: v11 predates the provisioning stage
 * and still takes its working directory from `/repositories/0/path`, and v13
 * carries the `UNIT_ID` binding that addressed every cohort's emit at a unit
 * that does not exist.
 *
 * `active` is the default listing — archived definitions are already off it, so
 * there is nothing here to re-archive. Strictly lower, so rolling the seed back
 * to an older build cannot retire a newer version that is still on offer.
 */
const supersededBuiltIns = (
  current: WorkflowDefinition,
  active: readonly WorkflowDefinition[],
): readonly WorkflowDefinition[] =>
  active.filter((candidate) =>
    SHIPPED_DEV_FLOW_IDS.has(candidate.id) && candidate.version < current.version);

export const seedBuiltins = async (repository: WorkflowDefinitionRepository): Promise<void> => {
  const definition = await loadDevFlowV15();
  if (!definition.ok) throw new Error(`built-in dev-flow v15 is invalid: ${definition.error.detail}`);
  const bundle = await createPromptBundle(definition.value,
    createPromptTemplateLoader(resolve(import.meta.dir, "../../../workflow-config/prompts")));
  await repository.insert_immutable(definition.value, bundle);

  // Archived, not deleted: `find_by_id` does not filter on it, so a run launched
  // against an older version still compiles the graph it was launched with.
  for (const stale of supersededBuiltIns(definition.value, await repository.list())) {
    await repository.set_archived(stale.id, true);
  }
};
