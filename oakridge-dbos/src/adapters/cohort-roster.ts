/**
 * The two things every cohort driver needs, shared rather than reimplemented:
 * the roster a started stage fans out over, and the id one cohort key resolves
 * to.
 *
 * A stage's roster comes from its stage-local definition, so a run
 * fans out over the version it was launched with. A scalar stage is one cohort
 * keyed `"0"` — the key every projection, prompt binding and publication
 * callback already addresses a single-cohort stage by.
 */
import { createHash } from "node:crypto";

import type { CompiledStageContract } from "../domain/compiled-workflow";
import { err, type Result, type CohortId, type JsonValue, type StageInstanceId } from "../domain/primitives";

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

/** Named materialization arrives in B4; a generic fan-out is not a fallback. */
export interface StageInitializationError {
  readonly operation: "initialize_stage_cohorts";
  readonly kind: "stage_initialization_unimplemented";
  readonly stage_key: string;
  readonly detail: string;
}
export interface CohortRosterEntry {
  readonly cohort_key: string;
  readonly item: JsonValue;
  readonly depends_on: readonly string[];
}
export const resolveCohortRoster = (
  contract: CompiledStageContract,
): Result<readonly CohortRosterEntry[], StageInitializationError> => err({
  operation: "initialize_stage_cohorts", kind: "stage_initialization_unimplemented",
  stage_key: contract.stage_key,
  detail: "Named v15 stage materialization is implemented by build boundary B4",
});
