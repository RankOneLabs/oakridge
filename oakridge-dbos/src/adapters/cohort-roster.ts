/**
 * The two things every cohort driver needs, shared rather than reimplemented:
 * the roster a started stage fans out over, and the id one cohort key resolves
 * to.
 *
 * A stage's roster comes from its pinned `MaterializationContract`, so a run
 * fans out over the version it was launched with. A scalar stage is one cohort
 * keyed `"0"` — the key every projection, prompt binding and publication
 * callback already addresses a single-cohort stage by.
 */
import { createHash } from "node:crypto";

import { resolveBindingValue } from "../compiler/resolve-execution";
import type { StageInputSet } from "../decision/commands";
import type { CompiledStageContract } from "../domain/compiled-workflow";
import { readJsonPointer } from "../domain/json-pointer";
import type { CohortId, JsonValue, StageInstanceId } from "../domain/primitives";

/** The key a stage with no fan-out addresses its single cohort by. */
export const SCALAR_COHORT_KEY = "0";

/**
 * One cohort per (stage instance, key) — exactly the uniqueness
 * `oakridge.cohort` enforces — so reopening a stage after recovery finds the
 * roster it already made rather than building a second one.
 */
export const cohortIdFor = (stage_instance_id: StageInstanceId, cohort_key: string): CohortId => {
  const hex = createHash("sha256").update(`v15-cohort:${stage_instance_id}:${cohort_key}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}` as CohortId;
};

/** One entry of a stage's roster: the key, and the item the stage fanned out over. */
export interface CohortRosterEntry {
  readonly cohort_key: string;
  readonly item: JsonValue;
  readonly depends_on: readonly string[];
}

/**
 * Resolves the roster from the pinned contract, the run context and the stage's
 * resolved inputs.
 *
 * The inputs are not optional: dev-flow's build stage fans out over the `brief`
 * input, so a roster resolved against the context alone reports that input as
 * missing and the stage opens no cohorts at all.
 *
 * A fan-out whose binding does not resolve to an array is an operational
 * failure, not an empty roster: a stage that quietly opened no cohorts would
 * leave the stage active without cohorts or any work to complete it.
 */
export const resolveCohortRoster = (
  contract: CompiledStageContract,
  run_context: JsonValue,
  inputs: StageInputSet,
): readonly CohortRosterEntry[] => {
  const materialization = contract.materialization;
  if (materialization.kind !== "fan_out") return [{ cohort_key: SCALAR_COHORT_KEY, item: null, depends_on: [] }];
  const resolved = resolveBindingValue(materialization.over, { inputs, context: run_context, item: null });
  if (!resolved.ok) throw new Error(`stage '${contract.stage_key}' fan-out did not resolve: ${resolved.error.detail}`);
  if (!Array.isArray(resolved.value)) throw new Error(`stage '${contract.stage_key}' fan-out did not resolve to an array`);
  const entries = resolved.value.map((item, index) => {
    const key = readJsonPointer(item, materialization.unit_id_path);
    const dependencies = materialization.depends_on_path === null ? []
      : readJsonPointer(item, materialization.depends_on_path);
    return { cohort_key: typeof key === "string" && key.length > 0 ? key : String(index), item,
      depends_on: Array.isArray(dependencies) && dependencies.every((dependency) => typeof dependency === "string")
        ? dependencies as string[] : [] };
  });
  const keys = new Set<string>();
  for (const entry of entries) {
    if (keys.has(entry.cohort_key)) throw new Error(`stage '${contract.stage_key}' has duplicate cohort key '${entry.cohort_key}'`);
    keys.add(entry.cohort_key);
  }
  if (materialization.depends_on_path !== null) {
    for (const entry of entries) {
      const dependencies = readJsonPointer(entry.item, materialization.depends_on_path);
      if (!Array.isArray(dependencies) || dependencies.some((dependency) => typeof dependency !== "string")) {
        throw new Error(`stage '${contract.stage_key}' unit '${entry.cohort_key}' has invalid dependencies`);
      }
      for (const dependency of dependencies) {
        if (!keys.has(dependency as string)) {
          throw new Error(`stage '${contract.stage_key}' unit '${entry.cohort_key}' has unknown dependency '${dependency}'`);
        }
      }
    }
  }
  return entries;
};
