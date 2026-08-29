import { Hono } from "hono";

import { parseUuidId, type RunUnitId } from "../domain/primitives";
import type { RunRecordRepository } from "../storage/repositories";

export interface OperatorRetryHttpDependencies {
  readonly records: Pick<RunRecordRepository, "retry_unit">;
  now(): string;
}

export const createOperatorRetryApp = (dependencies: OperatorRetryHttpDependencies): Hono => {
  const app = new Hono();
  app.put("/run-units/:runUnitId/retry", async (http) => {
    const runUnitId = parseUuidId<RunUnitId>(http.req.param("runUnitId"));
    if (!runUnitId) return http.json({ error: "invalid run unit id" }, 400);
    const idempotencyKey = http.req.header("idempotency-key")?.trim();
    if (!idempotencyKey) return http.json({ error: "Idempotency-Key header is required" }, 400);
    const result = await dependencies.records.retry_unit({ run_unit_id: runUnitId, idempotency_key: idempotencyKey, actor: "operator" }, dependencies.now());
    if (result.kind === "unit_not_found") return http.json({ error: result.detail }, 404);
    if (result.kind === "not_active" || result.kind === "work_in_progress" || result.kind === "no_missing_work" || result.kind === "actionable_wait" || result.kind === "no_execution_basis") {
      return http.json({ error: result.detail, kind: result.kind }, 409);
    }
    return http.json({ run_id: result.run_id, run_unit_id: runUnitId, work_order: result.work_order, record_version: result.record_version }, result.kind === "created" ? 202 : 200);
  });
  return app;
};
