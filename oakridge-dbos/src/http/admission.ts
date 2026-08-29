import { Hono } from "hono";

import { parseUuidId, type StageInstanceId, type UnitId } from "../domain/primitives";
import type { RunRecordRepository } from "../storage/repositories";

export interface AdmissionHttpDependencies {
  readonly records: Pick<RunRecordRepository, "admit_unit">;
  now(): string;
}

export const createAdmissionApp = (dependencies: AdmissionHttpDependencies): Hono => {
  const app = new Hono();
  app.put("/stages/:stageId/units/:unitId/admit", async (http) => {
    const stageInstanceId = parseUuidId<StageInstanceId>(http.req.param("stageId"));
    const unitId = http.req.param("unitId") as UnitId;
    if (!stageInstanceId) return http.json({ error: "invalid stage instance id" }, 400);
    const idempotencyKey = http.req.header("idempotency-key")?.trim();
    if (!idempotencyKey) return http.json({ error: "Idempotency-Key header is required" }, 400);
    const result = await dependencies.records.admit_unit({ stage_instance_id: stageInstanceId, unit_id: unitId, idempotency_key: idempotencyKey }, dependencies.now());
    if (result.kind === "stage_not_found" || result.kind === "unit_not_found") return http.json({ error: result.kind.replaceAll("_", " ") }, 404);
    if (result.kind === "not_manual") return http.json({ error: "stage does not use manual admission" }, 409);
    if (result.kind === "not_pending") return http.json({ error: "stage is not waiting for admission" }, 409);
    if (result.kind === "dependency_blocked") return http.json({ error: "stage unit dependencies are not complete", blocked_by: result.blocked_by }, 409);
    if (result.kind === "idempotency_conflict") return http.json({ error: "Idempotency-Key was already used for a different admission" }, 409);
    return http.json({ stage_instance_id: stageInstanceId, unit_id: unitId, admitted: true }, result.kind === "admitted" ? 202 : 200);
  });
  return app;
};
