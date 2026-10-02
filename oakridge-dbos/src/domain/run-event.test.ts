import { expect, test } from "bun:test";

import { projectRunEvent, type RunEventRow } from "./run-event";

test("a v15 transition projects owner-local versions and its typed effect descriptor", () => {
  const row: RunEventRow = {
    sequence: "42",
    id: "00000000-0000-4000-8000-000000000001",
    run_id: "00000000-0000-4000-8000-000000000002",
    owner_kind: "cohort",
    owner_run_id: null,
    owner_stage_instance_id: null,
    owner_cohort_id: "00000000-0000-4000-8000-000000000003",
    launch_reason: "artifact_accepted",
    prior_owner_version: "7",
    resulting_owner_version: "8",
    event: { kind: "derive" }, from_state: null, to_state: null, unit_label: null, target_next_actor: null,
    effect_descriptor: { kind: "example_adapter_finished", output_id: "artifact-1" },
    effect_workflow_id: "v15-effect:cohort:00000000-0000-4000-8000-000000000003:8",
    actor: "adapter",
    created_at: "2026-09-28T12:00:00.000Z",
  };
  const event = projectRunEvent(row);
  expect(event.sequence).toBe("42");
  expect(String(event.transition_id)).toBe(row.id);
  expect(String(event.run_id)).toBe(row.run_id);
  expect(event.owner.kind).toBe("cohort");
  expect(String(event.owner.id)).toBe(String(row.owner_cohort_id));
  expect(event.prior_owner_version).toBe(7);
  expect(event.resulting_owner_version).toBe(8);
  expect(event.operation).toBe("example_adapter_finished");
  expect(JSON.stringify(event.effect)).toBe(JSON.stringify(row.effect_descriptor));
  expect(event.effect_workflow_id).toBe(row.effect_workflow_id);
});

test("an inconsistent transition owner is refused at the projection boundary", () => {
  const row: RunEventRow = {
    sequence: "9",
    id: "00000000-0000-4000-8000-000000000001",
    run_id: "00000000-0000-4000-8000-000000000002",
    owner_kind: "cohort",
    owner_run_id: null,
    owner_stage_instance_id: "00000000-0000-4000-8000-000000000004",
    owner_cohort_id: "00000000-0000-4000-8000-000000000003",
    launch_reason: "recovery",
    prior_owner_version: "0",
    resulting_owner_version: "1",
    event: { kind: "derive" }, from_state: null, to_state: null, unit_label: null, target_next_actor: null,
    effect_descriptor: { kind: "none" },
    effect_workflow_id: "invalid",
    actor: "test",
    created_at: "2026-09-28T12:00:00.000Z",
  };
  expect(() => projectRunEvent(row)).toThrow("invalid owner identity");
});
