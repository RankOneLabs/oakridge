import type { StageUnit } from "../types";
/** The projection reads this body from the cohort's frozen brief reference. */
export const selectCohortBrief = (unit: StageUnit): StageUnit["brief"] => unit.brief;
