import { Hono } from "hono";
import { z } from "zod";

import { parseUuidId, type StageInstanceId, type UnitId } from "../domain/primitives";
import type { StageAdmissionState } from "../domain/runs";
import type { StageAdmissionTargetRepository } from "../storage/repositories";
import type { StageCommand } from "../workflows/production-topology";

export interface AdmissionHttpDependencies {
  readonly targets: StageAdmissionTargetRepository;
  readonly get_admission_state: (workflow_id: string) => Promise<StageAdmissionState | null>;
  readonly send_stage_command: (workflow_id: string, command: StageCommand, idempotency_key: string) => Promise<void>;
}

const requestSchema = z.object({ idempotency_key: z.string().trim().min(1) });

export const createAdmissionApp = (dependencies: AdmissionHttpDependencies): Hono => {
  const app = new Hono();
  app.post("/stages/:stageId/units/:unitId/admit", async (http) => {
    const stageInstanceId = parseUuidId<StageInstanceId>(http.req.param("stageId"));
    const unitId = http.req.param("unitId") as UnitId;
    const parsed = requestSchema.safeParse(await http.req.json().catch(() => null));
    if (!parsed.success) return http.json({ error: "idempotency_key is required" }, 400);
    const workflowId = stageInstanceId && await dependencies.targets.find_coordinator_workflow_id(stageInstanceId);
    if (!workflowId) return http.json({ error: "stage instance not found" }, 404);
    const state = await dependencies.get_admission_state(workflowId);
    if (!state || state.status !== "waiting") return http.json({ error: "stage is not waiting for admission" }, 409);
    if (!state.manual_admission) return http.json({ error: "stage does not use manual admission" }, 409);
    const unit = state.units.find((candidate) => candidate.unit_id === unitId);
    if (!unit) return http.json({ error: "stage unit not found" }, 404);
    if (unit.admitted) return http.json({ stage_instance_id: stageInstanceId, unit_id: unitId, admitted: true });
    if (!unit.eligible) return http.json({ error: "stage unit dependencies are not complete", blocked_by: unit.blocked_by }, 409);
    await dependencies.send_stage_command(workflowId, { kind: "admit_unit", unit_id: unitId }, `admit:${stageInstanceId}:${unitId}:${parsed.data.idempotency_key}`);
    return http.json({ stage_instance_id: stageInstanceId, unit_id: unitId, admitted: true }, 202);
  });
  return app;
};
