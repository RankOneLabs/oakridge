import { expect, test } from "bun:test";

import { projectRunEvent, type RunEventRow } from "./run-event";

test("a transition row projects its typed identity and slot continuation", () => {
  const row: RunEventRow = {
    sequence: "42", operation: "gate_opened", run_id: "00000000-0000-4000-8000-000000000001",
    run_unit_id: "00000000-0000-4000-8000-000000000002", stage_instance_id: "00000000-0000-4000-8000-000000000003",
    stage_key: "build", unit_id: "oakridge", work_order_id: "00000000-0000-4000-8000-000000000004",
    wait_id: "00000000-0000-4000-8000-000000000005", output_name: "build_result", collection_key: null,
    artifact_revision_id: "00000000-0000-4000-8000-000000000006", attention: "required", continuation: "waiting",
    detail: { gate_step: "artifact_approval" }, created_at: "2026-09-26T12:00:00.000Z",
  };
  const event = projectRunEvent(row);
  expect(event.sequence).toBe("42");
  expect(event.operation).toBe("gate_opened");
  expect(String(event.payload.run_id)).toBe(row.run_id);
  expect(String(event.payload.stage_instance_id)).toBe(row.stage_instance_id ?? "");
  expect(String(event.payload.unit_id)).toBe("oakridge");
  expect(event.payload.output_name).toBe("build_result");
  expect(String(event.payload.artifact_revision_id)).toBe(row.artifact_revision_id ?? "");
  expect(event.payload.attention).toBe("required");
  expect(event.payload.continuation).toBe("waiting");
});
