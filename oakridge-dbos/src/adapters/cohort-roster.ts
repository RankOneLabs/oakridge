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
}

/**
 * Resolves the roster from the pinned contract and the run context.
 *
 * A fan-out whose binding does not resolve to an array is an operational
 * failure, not an empty roster: a stage that quietly opened no cohorts would
 * complete immediately and let the run carry on past work nobody did.
 */
export const resolveCohortRoster = (
  contract: CompiledStageContract,
  run_context: JsonValue,
): readonly CohortRosterEntry[] => {
  const materialization = contract.materialization;
  if (materialization.kind !== "fan_out") return [{ cohort_key: SCALAR_COHORT_KEY, item: null }];
  const resolved = resolveBindingValue(materialization.over, { inputs: {}, context: run_context, item: null });
  if (!resolved.ok) throw new Error(`stage '${contract.stage_key}' fan-out did not resolve: ${resolved.error.detail}`);
  if (!Array.isArray(resolved.value)) throw new Error(`stage '${contract.stage_key}' fan-out did not resolve to an array`);
  return resolved.value.map((item, index) => {
    const key = readJsonPointer(item, materialization.unit_id_path);
    return { cohort_key: typeof key === "string" && key.length > 0 ? key : String(index), item };
  });
};
