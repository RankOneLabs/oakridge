import { Hono, type Context } from "hono";

import { parseUuidId, type CohortId, type StageInstanceId } from "../domain/primitives";
import type { RetryCohortResult, RetryCohortTarget } from "../domain/run-record";

export interface OperatorRetryHttpDependencies {
  retry_through_driver(target: RetryCohortTarget, idempotency_key: string): Promise<RetryCohortResult>;
}

/**
 * Operator retry of a cohort, addressed either by the cohort row id or by the
 * stage instance + cohort key kbbl's run detail already holds. Both forms
 * enter the cohort driver; the route only decides how the cohort is named.
 *
 * The path segments keep their `run-units` / `units` spelling: v15's cohort is
 * what v14 called a run unit, and the PWA addresses it by the same two ids.
 */
export const createOperatorRetryApp = (dependencies: OperatorRetryHttpDependencies): Hono => {
  const app = new Hono();
  const retry = async (http: Context, target: RetryCohortTarget) => {
    const idempotencyKey = http.req.header("idempotency-key")?.trim();
    if (!idempotencyKey) return http.json({ error: "Idempotency-Key header is required" }, 400);
    const result = await dependencies.retry_through_driver(target, idempotencyKey);
    if (result.kind === "cohort_not_found") return http.json({ error: result.detail }, 404);
    if (result.kind === "not_retryable") return http.json({ kind: result.kind, reason: result.reason }, 409);
    if (result.kind === "idempotency_conflict") return http.json({ error: result.detail, kind: result.kind }, 409);
    return http.json({ run_id: result.run_id, cohort_id: result.cohort_id, attempt_id: result.attempt_id,
      attempt_number: result.attempt_number, record_version: result.durable_version },
    result.kind === "created" ? 202 : 200);
  };
  app.put("/run-units/:runUnitId/retry", async (http) => {
    const cohortId = parseUuidId<CohortId>(http.req.param("runUnitId"));
    if (!cohortId) return http.json({ error: "invalid cohort id" }, 400);
    return retry(http, { kind: "cohort", cohort_id: cohortId });
  });
  app.put("/stage_instances/:stageInstanceId/units/:unitId/retry", async (http) => {
    const stageInstanceId = parseUuidId<StageInstanceId>(http.req.param("stageInstanceId"));
    if (!stageInstanceId) return http.json({ error: "invalid stage instance id" }, 400);
    const cohortKey = http.req.param("unitId");
    if (!cohortKey) return http.json({ error: "unit id is required" }, 400);
    return retry(http, { kind: "stage_cohort", stage_instance_id: stageInstanceId, cohort_key: cohortKey });
  });
  return app;
};
