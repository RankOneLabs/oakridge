import { Hono, type Context } from "hono";

import { parseUuidId, type RunUnitId, type StageInstanceId, type UnitId, type WorkflowRunId } from "../domain/primitives";
import type { RetryRunUnitTarget } from "../domain/run-record";
import type { RunRecordRepository } from "../storage/repositories";

export interface OperatorRetryHttpDependencies {
  readonly records: Pick<RunRecordRepository, "retry_unit">;
  now(): string;
  /** Wakes the run's root sooner than its bounded recheck; absent is fine — the recheck still starts the retry. */
  readonly send_run_wake?: (run_id: WorkflowRunId, idempotency_key: string) => Promise<void>;
}

/**
 * Operator retry of a run unit, addressed either by the run-record row id or
 * by the stage instance + unit id kbbl's run detail already holds. Both forms
 * are one repository operation; the route only decides how the unit is named.
 */
export const createOperatorRetryApp = (dependencies: OperatorRetryHttpDependencies): Hono => {
  const app = new Hono();
  const retry = async (http: Context, target: RetryRunUnitTarget) => {
    const idempotencyKey = http.req.header("idempotency-key")?.trim();
    if (!idempotencyKey) return http.json({ error: "Idempotency-Key header is required" }, 400);
    const result = await dependencies.records.retry_unit({ target, idempotency_key: idempotencyKey, actor: "operator" }, dependencies.now());
    if (result.kind === "unit_not_found") return http.json({ error: result.detail }, 404);
    if (result.kind === "not_active" || result.kind === "work_in_progress" || result.kind === "no_missing_work" || result.kind === "actionable_wait" || result.kind === "no_execution_basis") {
      return http.json({ error: result.detail, kind: result.kind }, 409);
    }
    if (result.kind === "created") await dependencies.send_run_wake?.(result.run_id, `operator_retry:${result.run_id}:${result.record_version}`).catch(() => undefined);
    return http.json({ run_id: result.run_id, run_unit_id: result.work_order.run_unit_id, work_order: result.work_order, record_version: result.record_version }, result.kind === "created" ? 202 : 200);
  };
  app.put("/run-units/:runUnitId/retry", async (http) => {
    const runUnitId = parseUuidId<RunUnitId>(http.req.param("runUnitId"));
    if (!runUnitId) return http.json({ error: "invalid run unit id" }, 400);
    return retry(http, { kind: "run_unit", run_unit_id: runUnitId });
  });
  app.put("/stage_instances/:stageInstanceId/units/:unitId/retry", async (http) => {
    const stageInstanceId = parseUuidId<StageInstanceId>(http.req.param("stageInstanceId"));
    if (!stageInstanceId) return http.json({ error: "invalid stage instance id" }, 400);
    const unitId = http.req.param("unitId");
    if (!unitId) return http.json({ error: "unit id is required" }, 400);
    return retry(http, { kind: "stage_unit", stage_instance_id: stageInstanceId, unit_id: unitId as UnitId });
  });
  return app;
};
