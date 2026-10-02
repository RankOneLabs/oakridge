import { Hono } from "hono";

import { parseUuidId, type Result, type CohortId } from "../domain/primitives";

export interface CohortPullRequestRefresh { readonly state: string }
export interface CohortPullRequestRefreshError {
  readonly operation: "refresh_pull_request";
  readonly cohort_id: CohortId;
  readonly detail: string;
}

export interface CohortPullRequestHttpDependencies {
  refresh(cohort_id: CohortId): Promise<Result<CohortPullRequestRefresh | null, CohortPullRequestRefreshError>>;
}

export const createCohortPullRequestApp = (dependencies: CohortPullRequestHttpDependencies): Hono => {
  const app = new Hono();
  app.post("/cohorts/:cohortId/pull_request/refresh", async (http) => {
    const cohort_id = parseUuidId<CohortId>(http.req.param("cohortId"));
    if (!cohort_id) return http.json({ error: "invalid cohort id" }, 400);
    const refreshed = await dependencies.refresh(cohort_id);
    if (!refreshed.ok) return http.json({ error: refreshed.error.detail }, 503);
    if (!refreshed.value) return http.json({ error: "cohort not found" }, 404);
    return http.json(refreshed.value, 200);
  });
  return app;
};
