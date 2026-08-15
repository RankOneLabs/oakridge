import { expect, test } from "bun:test";

import type { StageInstanceId, UnitId } from "../src/domain/primitives";
import { selectStageAdmissionState } from "../src/workflows/production-topology";

const stageId = "00000000-0000-4000-8000-000000000001" as StageInstanceId;
const first = "first" as UnitId;
const second = "second" as UnitId;
const units = [
  { unit_id: first, parameters: {}, depends_on: [] },
  { unit_id: second, parameters: {}, depends_on: [first] },
];

test("admission state exposes runtime units and dependency eligibility without scheduling in app code", () => {
  expect(selectStageAdmissionState(stageId, units, new Set(), new Set(), true)).toEqual({
    stage_instance_id: stageId,
    status: "waiting",
    manual_admission: true,
    units: [
      { unit_id: first, parameters: {}, admitted: false, eligible: true, blocked_by: [] },
      { unit_id: second, parameters: {}, admitted: false, eligible: false, blocked_by: [first] },
    ],
  });
});

test("released dependencies mechanically make their siblings eligible", () => {
  const state = selectStageAdmissionState(stageId, units, new Set([second]), new Set([first]), true);
  expect(state.units[1]).toEqual({ unit_id: second, parameters: {}, admitted: true, eligible: true, blocked_by: [] });
});
