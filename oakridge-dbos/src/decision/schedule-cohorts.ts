import type { CoreStatus } from "../domain/records";
import type { BuildBriefBody, PlanBody, PlanCohort } from "../domain/dev-flow-artifacts";
import { err, ok, type Result } from "../domain/primitives";

export type PlanCohortErrorKind = "empty_plan" | "invalid_cohort_key" | "duplicate_cohort_key"
  | "unknown_repository" | "self_dependency" | "unknown_dependency" | "cyclic_dependency";
export interface PlanCohortError {
  readonly operation: "validate_plan_cohorts";
  readonly kind: PlanCohortErrorKind;
  readonly cohort_key: string | null;
  readonly detail: string;
}

/** A cohort key is used verbatim in both a git ref segment and a worktree path segment. */
export const isLegalCohortKey = (key: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) && !key.endsWith(".lock")
  && key !== "." && key !== ".." && !key.includes("..") && !key.endsWith(".");

export const validatePlanCohorts = (plan: PlanBody, repository_keys: ReadonlySet<string>): Result<readonly PlanCohort[], PlanCohortError> => {
  const fail = (kind: PlanCohortErrorKind, cohort_key: string | null, detail: string): Result<never, PlanCohortError> =>
    err({ operation: "validate_plan_cohorts", kind, cohort_key, detail });
  if (plan.cohorts.length === 0) return fail("empty_plan", null, "accepted plan must contain at least one cohort");
  const byKey = new Map<string, PlanCohort>();
  for (const cohort of plan.cohorts) {
    if (!isLegalCohortKey(cohort.id)) return fail("invalid_cohort_key", cohort.id, `cohort key '${cohort.id}' is not a legal branch and path segment`);
    if (byKey.has(cohort.id)) return fail("duplicate_cohort_key", cohort.id, `cohort key '${cohort.id}' is repeated`);
    if (!repository_keys.has(cohort.repository_key)) return fail("unknown_repository", cohort.id,
      `cohort '${cohort.id}' names unknown repository '${cohort.repository_key}'`);
    byKey.set(cohort.id, cohort);
  }
  for (const cohort of plan.cohorts) {
    for (const dependency of cohort.depends_on) {
      if (dependency === cohort.id) return fail("self_dependency", cohort.id, `cohort '${cohort.id}' depends on itself`);
      if (!byKey.has(dependency)) return fail("unknown_dependency", cohort.id,
        `cohort '${cohort.id}' depends on unknown cohort '${dependency}'`);
    }
  }
  const active = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (active.has(key)) return false;
    if (visited.has(key)) return true;
    active.add(key);
    for (const dependency of byKey.get(key)?.depends_on ?? []) if (!visit(dependency)) return false;
    active.delete(key);
    visited.add(key);
    return true;
  };
  for (const cohort of plan.cohorts) if (!visit(cohort.id)) return fail("cyclic_dependency", cohort.id,
    `dependency graph contains a cycle involving '${cohort.id}'`);
  return ok(plan.cohorts);
};

export type BriefCollectionErrorKind = "missing_member" | "unknown_member" | "duplicate_member"
  | "repository_changed" | "dependencies_changed" | "acceptance_criteria_changed";
export interface BriefCollectionError {
  readonly operation: "validate_brief_collection";
  readonly kind: BriefCollectionErrorKind;
  readonly cohort_key: string;
  readonly detail: string;
}

/** The collection is one review decision, so any mismatch rejects the whole set. */
export const validateBriefCollection = (plan: readonly PlanCohort[], briefs: readonly BuildBriefBody[]):
  Result<readonly BuildBriefBody[], BriefCollectionError> => {
  const fail = (kind: BriefCollectionErrorKind, cohort_key: string, detail: string): Result<never, BriefCollectionError> =>
    err({ operation: "validate_brief_collection", kind, cohort_key, detail });
  const planned = new Map(plan.map((cohort) => [cohort.id, cohort]));
  const seen = new Set<string>();
  for (const brief of briefs) {
    const key = brief.cohort_id;
    if (seen.has(key)) return fail("duplicate_member", key, `brief '${key}' is repeated`);
    seen.add(key);
    const cohort = planned.get(key);
    if (!cohort) return fail("unknown_member", key, `brief '${key}' is absent from the accepted plan`);
    if (brief.repository_key !== cohort.repository_key) return fail("repository_changed", key, `brief '${key}' changed repository assignment`);
    if (brief.depends_on.length !== cohort.depends_on.length
      || new Set(brief.depends_on).size !== brief.depends_on.length
      || brief.depends_on.some((dependency) => !cohort.depends_on.includes(dependency)))
      return fail("dependencies_changed", key, `brief '${key}' changed dependencies`);
    if (brief.acceptance_criteria.length !== cohort.acceptance_criteria.length
      || brief.acceptance_criteria.some((criterion, index) => criterion !== cohort.acceptance_criteria[index]))
      return fail("acceptance_criteria_changed", key, `brief '${key}' changed acceptance criteria`);
  }
  for (const cohort of plan) if (!seen.has(cohort.id)) return fail("missing_member", cohort.id,
    `accepted plan cohort '${cohort.id}' has no brief`);
  return ok(briefs);
};

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
    .map((cohort) => cohort.cohort_key).slice(0, Math.max(0, max_parallel - occupied));
};
