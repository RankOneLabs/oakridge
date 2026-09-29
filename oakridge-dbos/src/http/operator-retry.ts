import { Hono, type Context } from "hono";

import { parseUuidId, type CohortId, type StageInstanceId, type WorkflowRunId } from "../domain/primitives";
import type { RetryCohortTarget } from "../domain/run-record";
import type { RunRecordRepository } from "../storage/repositories";

export interface OperatorRetryHttpDependencies {
  readonly records: Pick<RunRecordRepository, "retry_cohort">;
  now(): string;
  /** Wakes the cohort's machine sooner than its bounded recheck; absent is fine — the recheck still starts the retry. */
  readonly send_cohort_wake?: (cohort_id: CohortId, idempotency_key: string) => Promise<void>;
  /** Wakes the run's root so the retry shows up in its projections without waiting. */
  readonly send_run_wake?: (run_id: WorkflowRunId, idempotency_key: string) => Promise<void>;
}

/**
 * Operator retry of a cohort, addressed either by the cohort row id or by the
 * stage instance + cohort key kbbl's run detail already holds. Both forms are
 * one repository operation; the route only decides how the cohort is named.
 *
 * The path segments keep their `run-units` / `units` spelling: v15's cohort is
 * what v14 called a run unit, and the PWA addresses it by the same two ids.
 */
export const createOperatorRetryApp = (dependencies: OperatorRetryHttpDependencies): Hono => {
  const app = new Hono();
  const retry = async (http: Context, target: RetryCohortTarget) => {
    const idempotencyKey = http.req.header("idempotency-key")?.trim();
    if (!idempotencyKey) return http.json({ error: "Idempotency-Key header is required" }, 400);
    const result = await dependencies.records.retry_cohort({ target, idempotency_key: idempotencyKey, actor: "operator" }, dependencies.now());
    if (result.kind === "cohort_not_found") return http.json({ error: result.detail }, 404);
    if (result.kind === "not_active" || result.kind === "work_in_progress" || result.kind === "actionable_wait") {
      return http.json({ error: result.detail, kind: result.kind }, 409);
    }
    if (result.kind === "idempotency_conflict") return http.json({ error: result.detail, kind: result.kind }, 409);
    if (result.kind === "created") {
      const key = `operator_retry:${result.cohort_id}:${result.attempt_number}`;
      await dependencies.send_cohort_wake?.(result.cohort_id, key).catch(() => undefined);
      await dependencies.send_run_wake?.(result.run_id, key).catch(() => undefined);
    }
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
