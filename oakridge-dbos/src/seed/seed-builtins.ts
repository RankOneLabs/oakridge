import type { WorkflowDefinitionRepository } from "../storage/repositories";
import type { WorkflowDefinition } from "../domain/workflow";
import { loadDevFlowV14 } from "./dev-flow-v14";

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
 * `oakridge-core/examples`, so listing them is that knowledge made explicit, and
 * the failure mode is now the harmless direction: an id missing from this list
 * means that version keeps appearing in the launcher, never that someone else's
 * definition disappears from it.
 *
 * A new version adds its id here.
 */
const SHIPPED_DEV_FLOW_IDS: ReadonlySet<string> = new Set([
  "00000000-0000-0000-0000-000000000001", // v1
  "7f80ea26-a412-46fa-9446-0d8a84cd92b8", // v3
  "3859fc47-bd74-4c6e-aab8-0e123285d151", // v4
  "018dea85-c156-4317-991b-25e99ddf6bb4", // v5
  "018dea85-c156-4317-991b-25e99ddf6bb5", // v6
  "75715664-8490-48f7-96bc-2b461bd79f17", // v7
  "a7e0a90e-c854-420c-b3ad-2ab97f8298b0", // v8
  "c524667d-a09a-46bb-ae8f-da763d865815", // v9
  "ef2b47a4-d1bd-44ee-840a-e4f7b27570db", // v11
  "6d1e9a52-3c74-4c1f-9a3e-2f5b8c0d41a7", // v12
  "7c4a1f38-9b52-4d6e-8a17-3e0c5b9d24f1", // v13
  "3f7b2c95-6d41-4e88-9a52-c1e0f4b7d206", // v14
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
  const definition = await loadDevFlowV14();
  if (!definition.ok) throw new Error(`built-in dev-flow v14 is invalid: ${definition.error.detail}`);
  await repository.insert_immutable(definition.value);

  // Archived, not deleted: `find_by_id` does not filter on it, so a run launched
  // against an older version still compiles the graph it was launched with.
  for (const stale of supersededBuiltIns(definition.value, await repository.list())) {
    await repository.set_archived(stale.id, true);
  }
};
