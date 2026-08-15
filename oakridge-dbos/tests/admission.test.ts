import { expect, test } from "bun:test";

import type { StageInstanceId, UnitId } from "../src/domain/primitives";
import type { StageAdmissionState } from "../src/domain/runs";
import { createAdmissionApp } from "../src/http/admission";

const stageId = "00000000-0000-4000-8000-000000000001" as StageInstanceId;
const unitId = "web" as UnitId;
const state: StageAdmissionState = { stage_instance_id: stageId, status: "waiting", manual_admission: true,
  units: [{ unit_id: unitId, parameters: {}, admitted: false, eligible: true, blocked_by: [] }] };

const request = (app: ReturnType<typeof createAdmissionApp>) => app.request(`/stages/${stageId}/units/${unitId}/admit`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotency_key: "operator-1" }),
});

test("manual admission sends one durable command to the owning stage workflow", async () => {
  const sent: unknown[] = [];
  const app = createAdmissionApp({ targets: { find_coordinator_workflow_id: async () => "stage-workflow" }, get_admission_state: async () => state,
    send_stage_command: async (workflowId, command, key) => { sent.push({ workflowId, command, key }); } });
  const response = await request(app);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ stage_instance_id: stageId, unit_id: unitId, admitted: true });
  expect(sent).toEqual([{ workflowId: "stage-workflow", command: { kind: "admit_unit", unit_id: unitId }, key: `admit:${stageId}:${unitId}:operator-1` }]);
});

test("admission rejects engine-reported dependency blocks without inferring eligibility", async () => {
  const app = createAdmissionApp({ targets: { find_coordinator_workflow_id: async () => "stage-workflow" },
    get_admission_state: async () => ({ ...state, units: [{ unit_id: unitId, parameters: {}, admitted: false, eligible: false, blocked_by: ["api" as UnitId] }] }),
    send_stage_command: async () => { throw new Error("must not send"); } });
  const response = await request(app);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "stage unit dependencies are not complete", blocked_by: ["api"] });
});

test("admission is idempotent once the workflow reports the unit admitted", async () => {
  const app = createAdmissionApp({ targets: { find_coordinator_workflow_id: async () => "stage-workflow" },
    get_admission_state: async () => ({ ...state, units: [{ ...state.units[0]!, admitted: true }] }),
    send_stage_command: async () => { throw new Error("must not resend"); } });
  const response = await request(app);
  expect(response.status).toBe(200);
});
