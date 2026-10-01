import type { CoreStatus } from "../domain/records";

export interface SchedulableCohort {
  readonly cohort_key: string;
  readonly state_status: CoreStatus;
  readonly depends_on: readonly string[];
}

export const selectStartableCohorts = (cohorts: readonly SchedulableCohort[], max_parallel: number): readonly string[] => {
  const statusByKey = new Map(cohorts.map((cohort) => [cohort.cohort_key, cohort.state_status]));
  const occupied = cohorts.filter((cohort) => cohort.state_status === "active" || cohort.state_status === "blocked").length;
  return cohorts.filter((cohort) => cohort.state_status === "pending"
    && cohort.depends_on.every((key) => statusByKey.get(key) === "complete"))
    .map((cohort) => cohort.cohort_key).sort().slice(0, Math.max(0, max_parallel - occupied));
};
