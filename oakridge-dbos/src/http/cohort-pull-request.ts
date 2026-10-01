import { Hono } from "hono";

import { parseUuidId, type CohortId } from "../domain/primitives";

export interface CohortPullRequestHttpDependencies {
  refresh(cohort_id: CohortId): Promise<{ readonly state: string } | null>;
}

export const createCohortPullRequestApp = (dependencies: CohortPullRequestHttpDependencies): Hono => {
  const app = new Hono();
  app.post("/cohorts/:cohortId/pull_request/refresh", async (http) => {
    const cohort_id = parseUuidId<CohortId>(http.req.param("cohortId"));
    if (!cohort_id) return http.json({ error: "invalid cohort id" }, 400);
    const refreshed = await dependencies.refresh(cohort_id);
    if (!refreshed) return http.json({ error: "cohort not found" }, 404);
    return http.json(refreshed, 200);
  });
  return app;
};
