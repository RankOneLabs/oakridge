import { expect, test } from "bun:test";

import type { StageInstanceId, UnitId } from "../src/domain/primitives";
import type { AdmitStageUnitResult } from "../src/domain/runs";
import { createAdmissionApp } from "../src/http/admission";

const stageId = "00000000-0000-4000-8000-000000000001" as StageInstanceId;
const unitId = "web" as UnitId;

const request = (app: ReturnType<typeof createAdmissionApp>, key = "operator-1") => app.request(`/stages/${stageId}/units/${unitId}/admit`, {
  method: "PUT", headers: { "idempotency-key": key },
});

const appFor = (result: AdmitStageUnitResult) => createAdmissionApp({
  records: { admit_unit: async () => result }, now: () => "2026-08-29T12:00:00.000Z",
});

test("manual admission asks the run-owned repository with the header idempotency key", async () => {
  const calls: unknown[] = [];
  const app = createAdmissionApp({ records: { admit_unit: async (input, at) => {
    calls.push({ input, at });
    return { kind: "admitted", stage_instance_id: stageId, unit_id: unitId };
  } }, now: () => "2026-08-29T12:00:00.000Z" });
  const response = await request(app);
  expect(response.status).toBe(202);
  expect(calls).toEqual([{ input: { stage_instance_id: stageId, unit_id: unitId, idempotency_key: "operator-1" }, at: "2026-08-29T12:00:00.000Z" }]);
});

test("admission reports persisted dependency blocks", async () => {
  const response = await request(appFor({ kind: "dependency_blocked", stage_instance_id: stageId, unit_id: unitId, blocked_by: ["api" as UnitId] }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "stage unit dependencies are not complete", blocked_by: ["api"] });
});

test("identical admission retries return the already-applied result", async () => {
  const response = await request(appFor({ kind: "already_admitted", stage_instance_id: stageId, unit_id: unitId }));
  expect(response.status).toBe(200);
});

test("admission requires the HTTP Idempotency-Key header", async () => {
  const response = await request(appFor({ kind: "admitted", stage_instance_id: stageId, unit_id: unitId }), "");
  expect(response.status).toBe(400);
});
