import { expect, test } from "bun:test";

import { derive } from "../../src/decision/derive";
import type { Command } from "../../src/decision/commands";
import type { UnitId } from "../../src/domain/primitives";
import {
  PRODUCER_STAGE_KEY,
  availableBrief,
  emptyDefinition,
  fanOutDefinition,
  fingerprintForBrief,
  openWait,
  releasedSlot,
  emptySlot,
  runUnitIdForTest,
  scalarStageDefinition,
  snapshot,
  stage,
  unit,
  workOrder,
} from "./snapshot-builder";

// -----------------------------------------------------------------------
// 1. open collection, one unit with an unknown dependency → wait, no
//    contradiction, unit not started; then the dependency's unit arrives
//    with no row of its own → still wait.

test("case 1: an open collection materializes a unit whose dependency has no row yet, and starts nothing", () => {
  const definition = fanOutDefinition({ stage_key: "build", over_input: "brief", max_parallel: 2 });
  const rolloutBrief = availableBrief("rollout", ["versioning"]);
  const snap = snapshot({ definition, available_artifacts: [rolloutBrief], stages: [stage({ stage_key: "build", units: [] })] });

  const result = derive(snap);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.commands).toEqual([
    { kind: "materialize_unit", stage_key: "build", stage_instance_id: snap.stages[0]!.id, run_unit_id: runUnitIdForTest("build", "rollout"),
      unit_id: "rollout" as UnitId, parameters: expect.anything(), depends_on: ["versioning" as UnitId], inputs: expect.anything(),
      input_snapshot: expect.anything(), input_fingerprint: expect.anything(), outputs: expect.anything(), policy: expect.anything() },
  ]);
  expect(result.value.commands.some((command) => command.kind === "start_work")).toBe(false);
});

test("case 1 continued: the dependent unit exists but its dependency has no row → wait", () => {
  const definition = fanOutDefinition({ stage_key: "build", over_input: "brief", max_parallel: 2 });
  const rolloutBrief = availableBrief("rollout", ["versioning"]);
  const snap = snapshot({
    definition, available_artifacts: [rolloutBrief],
    stages: [stage({ stage_key: "build", units: [
      unit({ stage_key: "build", unit_id: "rollout", state: "ready", depends_on: ["versioning"], input_fingerprint: fingerprintForBrief(rolloutBrief), work_orders: [workOrder({ state: "available" })] }),
    ] })],
  });

  const result = derive(snap);
  expect(result).toEqual({ ok: true, value: { commands: [] } });
});

// -----------------------------------------------------------------------
// 2. the missing dependency arrives and is satisfied → the dependent starts.

test("case 2: a satisfied dependency lets its dependent's available order start", () => {
  const definition = fanOutDefinition({ stage_key: "build", over_input: "brief", max_parallel: 2 });
  const rolloutBrief = availableBrief("rollout", ["versioning"]);
  const versioningBrief = availableBrief("versioning", []);
  const order = workOrder({ state: "available" });
  const snap = snapshot({
    definition, available_artifacts: [rolloutBrief, versioningBrief],
    stages: [stage({ stage_key: "build", max_parallel: 2, units: [
      unit({ stage_key: "build", unit_id: "versioning", state: "satisfied", input_fingerprint: fingerprintForBrief(versioningBrief), required_slots: [releasedSlot()] }),
      unit({ stage_key: "build", unit_id: "rollout", state: "ready", depends_on: ["versioning"], input_fingerprint: fingerprintForBrief(rolloutBrief), work_orders: [order] }),
    ] })],
  });

  const result = derive(snap);
  expect(result).toEqual({ ok: true, value: { commands: [{ kind: "start_work", work_order_id: order.id, run_unit_id: runUnitIdForTest("build", "rollout") }] } });
});

// -----------------------------------------------------------------------
// 3. close with an unresolved dependency → unknown_dependency_at_close.

test("case 3: closing with a dependency that names no unit is a contradiction", () => {
  const definition = fanOutDefinition({ stage_key: "build", over_input: "brief" });
  const producer = stage({ stage_key: PRODUCER_STAGE_KEY, materialization_closed: true, units: [unit({ stage_key: PRODUCER_STAGE_KEY, unit_id: "0", state: "satisfied", required_slots: [releasedSlot()] })] });
  const build = stage({ stage_key: "build", units: [unit({ stage_key: "build", unit_id: "b", depends_on: ["never"] })] });
  const snap = snapshot({ definition, available_artifacts: [], stages: [producer, build] });

  const result = derive(snap);
  expect(result).toEqual({ ok: false, error: { kind: "unknown_dependency_at_close", stage_key: "build", unit_id: "b" as UnitId, dependency: "never" as UnitId } });
});

// -----------------------------------------------------------------------
// 4. a cycle among known units, collection still open → dependency_cycle.

test("case 4: a cycle among already-known units is a contradiction, independent of closure", () => {
  const definition = fanOutDefinition({ stage_key: "build", over_input: "brief" });
  const driver = availableBrief("a", ["b"]); // keeps the stage "ready"; the cycle is proven from the stored units below
  const snap = snapshot({
    definition, available_artifacts: [driver],
    stages: [stage({ stage_key: "build", units: [
      unit({ stage_key: "build", unit_id: "a", depends_on: ["b"] }),
      unit({ stage_key: "build", unit_id: "b", depends_on: ["a"] }),
    ] })],
  });

  const result = derive(snap);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toEqual({ kind: "dependency_cycle", stage_key: "build", cycle: ["a" as UnitId, "b" as UnitId, "a" as UnitId] });
});

// -----------------------------------------------------------------------
// 5. capacity: four eligible, max_parallel=2 → two start_work, in unit_id order.

test("case 5: capacity admits only the two lowest unit_ids, in order", () => {
  const eligible = (unit_id: string) => unit({ stage_key: "build", unit_id, work_orders: [workOrder({ state: "available" })] });
  const snap = snapshot({
    stages: [stage({ stage_key: "build", max_parallel: 2, units: [eligible("alpha"), eligible("bravo"), eligible("charlie"), eligible("delta")] })],
  });

  const result = derive(snap);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const started = result.value.commands.filter((command): command is Extract<Command, { kind: "start_work" }> => command.kind === "start_work");
  expect(started.map((command) => command.run_unit_id)).toEqual([runUnitIdForTest("build", "alpha"), runUnitIdForTest("build", "bravo")]);
});

// -----------------------------------------------------------------------
// 6. manual admission: eligible but unadmitted → wait.

test("case 6: manual admission withholds an otherwise-eligible unit until admitted", () => {
  const snap = snapshot({
    stages: [stage({ stage_key: "build", manual_admission: true, units: [
      unit({ stage_key: "build", unit_id: "u", admitted: false, work_orders: [workOrder({ state: "available" })] }),
    ] })],
  });

  const result = derive(snap);
  expect(result).toEqual({ ok: true, value: { commands: [] } });
});

// -----------------------------------------------------------------------
// 7. revision: same unit_id, new fingerprint → revise_unit, no new unit.

test("case 7: a driver artifact with a changed body revises the existing unit, not a new one", () => {
  const definition = fanOutDefinition({ stage_key: "build", over_input: "brief" });
  const revisedBrief = availableBrief("rollout", ["versioning"], undefined, { depends_on: ["versioning"], revision: 2 });
  const snap = snapshot({
    definition, available_artifacts: [revisedBrief],
    stages: [stage({ stage_key: "build", units: [unit({ stage_key: "build", unit_id: "rollout", depends_on: ["versioning"], input_fingerprint: "stale-fingerprint" })] })],
  });

  const result = derive(snap);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.commands).toEqual([
    { kind: "revise_unit", stage_key: "build", stage_instance_id: snap.stages[0]!.id, run_unit_id: runUnitIdForTest("build", "rollout"),
      unit_id: "rollout" as UnitId, parameters: expect.anything(), inputs: expect.anything(), input_snapshot: expect.anything(), input_fingerprint: expect.anything() },
  ]);
});

test("case 7 continued: a closed collection still revises an existing unit, and never mints a new one", () => {
  const definition = fanOutDefinition({ stage_key: "build", over_input: "brief" });
  const revisedBrief = availableBrief("rollout", [], undefined, { depends_on: [], revision: 2 });
  const lateBrief = availableBrief("late", []);
  const snap = snapshot({
    definition, available_artifacts: [revisedBrief, lateBrief],
    stages: [stage({ stage_key: "build", materialization_closed: true,
      units: [unit({ stage_key: "build", unit_id: "rollout", input_fingerprint: "stale-fingerprint", state: "satisfied", required_slots: [releasedSlot()] })] })],
  });

  const result = derive(snap);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // No `mark_stage_succeeded` alongside the revision: the batch resets the unit to `ready`,
  // and a stage succeeded in the same batch would never start the revised order.
  expect(result.value.commands.map((command) => command.kind)).toEqual(["revise_unit"]);
});

// -----------------------------------------------------------------------
// 8. malformed driver artifact → malformed_driver_artifact naming the artifact and path.

test("case 8: a driver artifact whose depends_on is not an array is a contradiction naming the artifact and path", () => {
  const definition = fanOutDefinition({ stage_key: "build", over_input: "brief" });
  const malformed = availableBrief("rollout", [], undefined, { depends_on: "not-an-array" });
  const snap = snapshot({ definition, available_artifacts: [malformed] });

  const result = derive(snap);
  expect(result).toEqual({
    ok: false,
    error: { kind: "malformed_driver_artifact", stage_key: "build", artifact_id: malformed.artifact_id, path: "/artifact/depends_on", detail: "depends_on must be an array of non-empty strings" },
  });
});

// -----------------------------------------------------------------------
// 9. every case from the deleted run-decisions.test.ts, re-expressed against derive.

test("case 9a: all required slots released marks the unit satisfied", () => {
  const snap = snapshot({ stages: [stage({ stage_key: "build", units: [unit({ stage_key: "build", unit_id: "u", state: "working", required_slots: [releasedSlot()] })] })] });
  expect(derive(snap)).toEqual({ ok: true, value: { commands: [{ kind: "mark_unit_satisfied", run_unit_id: runUnitIdForTest("build", "u") }] } });
});

// `every` over no slots is vacuously true. A unit with no required output has
// no discharge condition, so it is never satisfied — not even with a work
// order sitting available, which would otherwise be completed by the
// satisfaction before it could start.
test("case 9a': a unit with no required slots is never marked satisfied", () => {
  const snap = snapshot({
    stages: [stage({ stage_key: "build", units: [unit({ stage_key: "build", unit_id: "u", state: "ready", required_slots: [], work_orders: [workOrder({ state: "available" })] })] })],
  });
  const commands = (derive(snap) as { ok: true; value: { commands: readonly Command[] } }).value.commands;
  expect(commands.map((command) => command.kind)).toEqual(["start_work"]);
});

test("case 9b: an open wait blocks start_work even with an available order", () => {
  const snap = snapshot({
    stages: [stage({ stage_key: "build", units: [unit({ stage_key: "build", unit_id: "u", state: "working", open_waits: [openWait()], work_orders: [workOrder({ state: "available" })] })] })],
  });
  expect(derive(snap)).toEqual({ ok: true, value: { commands: [] } });
});

test("case 9c: an available order on an eligible unit starts", () => {
  const order = workOrder({ state: "available" });
  const snap = snapshot({ stages: [stage({ stage_key: "build", units: [unit({ stage_key: "build", unit_id: "u", work_orders: [order] })] })] });
  expect(derive(snap)).toEqual({ ok: true, value: { commands: [{ kind: "start_work", work_order_id: order.id, run_unit_id: runUnitIdForTest("build", "u") }] } });
});

test("case 9d: a started order yields no command", () => {
  const snap = snapshot({ stages: [stage({ stage_key: "build", units: [unit({ stage_key: "build", unit_id: "u", work_orders: [workOrder({ state: "started" })] })] })] });
  expect(derive(snap)).toEqual({ ok: true, value: { commands: [] } });
});

test("case 9e: no order and missing slots yields no command", () => {
  const snap = snapshot({ stages: [stage({ stage_key: "build", units: [unit({ stage_key: "build", unit_id: "u" })] })] });
  expect(derive(snap)).toEqual({ ok: true, value: { commands: [] } });
});

test("case 9f: a gate-failed unit completes the run with that unit's outcome, and nothing else", () => {
  const outcome = { kind: "failed" as const, code: "gate_rejected", detail: "operator rejected" };
  const snap = snapshot({
    stages: [stage({ stage_key: "build", units: [
      unit({ stage_key: "build", unit_id: "u", state: "failed", outcome, work_orders: [workOrder({ state: "available" })] }),
      unit({ stage_key: "build", unit_id: "v", work_orders: [workOrder({ state: "available" })] }),
    ] })],
  });
  expect(derive(snap)).toEqual({ ok: true, value: { commands: [{ kind: "complete_run", outcome }] } });
});

test("case 9g: a cancelled unit completes the run cancelled", () => {
  const outcome = { kind: "cancelled" as const, reason: "operator cancelled" };
  const snap = snapshot({ stages: [stage({ stage_key: "build", units: [unit({ stage_key: "build", unit_id: "u", state: "cancelled", outcome })] })] });
  expect(derive(snap)).toEqual({ ok: true, value: { commands: [{ kind: "complete_run", outcome }] } });
});

// -----------------------------------------------------------------------
// 10. retry/revision leftovers: a completed/abandoned history plus a new
//     available order starts; the same unit with a started order does not.

test("case 10a: completed and abandoned orders never block a newer available one", () => {
  const completed = workOrder({ state: "completed", created_at: "2026-08-01T00:00:00.000Z" });
  const abandoned = workOrder({ state: "abandoned", created_at: "2026-08-02T00:00:00.000Z" });
  const available = workOrder({ state: "available", created_at: "2026-08-03T00:00:00.000Z" });
  const snap = snapshot({ stages: [stage({ stage_key: "build", units: [unit({ stage_key: "build", unit_id: "u", work_orders: [completed, abandoned, available] })] })] });
  expect(derive(snap)).toEqual({ ok: true, value: { commands: [{ kind: "start_work", work_order_id: available.id, run_unit_id: runUnitIdForTest("build", "u") }] } });
});

test("case 10b: a started order blocks start_work even alongside completed, abandoned, and available orders", () => {
  const completed = workOrder({ state: "completed", created_at: "2026-08-01T00:00:00.000Z" });
  const abandoned = workOrder({ state: "abandoned", created_at: "2026-08-02T00:00:00.000Z" });
  const started = workOrder({ state: "started", created_at: "2026-08-03T00:00:00.000Z" });
  const available = workOrder({ state: "available", created_at: "2026-08-04T00:00:00.000Z" });
  const snap = snapshot({ stages: [stage({ stage_key: "build", units: [unit({ stage_key: "build", unit_id: "u", work_orders: [completed, abandoned, started, available] })] })] });
  expect(derive(snap)).toEqual({ ok: true, value: { commands: [] } });
});

// -----------------------------------------------------------------------
// 11. stalled: a started order whose unit's required slots are unreleased → no command;
//     UnitSnapshot carries no executor-health field.

test("case 11: a stalled started order with an unreleased slot and no wait yields no command", () => {
  const snap = snapshot({
    stages: [stage({ stage_key: "build", units: [unit({ stage_key: "build", unit_id: "u", state: "working", work_orders: [workOrder({ state: "started" })], required_slots: [emptySlot()], open_waits: [] })] })],
  });
  expect(derive(snap)).toEqual({ ok: true, value: { commands: [] } });
});

test("case 11 continued: UnitSnapshot carries no executor-health field for derive to (mis)read", () => {
  const built = unit({ stage_key: "build", unit_id: "u" });
  expect(Object.keys(built).sort()).toEqual(["admitted", "depends_on", "id", "input_fingerprint", "open_waits", "outcome", "parameters", "required_slots", "state", "unit_id", "work_orders"]);
});

// -----------------------------------------------------------------------
// 12. determinism: derive(snapshot) twice, and with stages/units reversed, yields identical commands.

test("case 12: derive is deterministic across repeated calls and reversed array order", () => {
  const orderY = workOrder({ state: "available" });
  const orderQ = workOrder({ state: "available" });
  const alpha = stage({ stage_key: "alpha", units: [
    unit({ stage_key: "alpha", unit_id: "y", work_orders: [orderY] }),
    unit({ stage_key: "alpha", unit_id: "x", admitted: false, work_orders: [workOrder({ state: "available" })] }),
  ] });
  const zulu = stage({ stage_key: "zulu", units: [
    unit({ stage_key: "zulu", unit_id: "q", work_orders: [orderQ] }),
    unit({ stage_key: "zulu", unit_id: "p" }),
  ] });
  const snap = snapshot({ stages: [alpha, zulu] });
  const first = derive(snap);
  const second = derive(snap);
  expect(second).toEqual(first);

  const reversedAlpha = stage({ stage_key: "alpha", units: [
    unit({ stage_key: "alpha", unit_id: "x", admitted: false, work_orders: [workOrder({ state: "available" })] }),
    unit({ stage_key: "alpha", unit_id: "y", work_orders: [orderY] }),
  ] });
  const reversedZulu = stage({ stage_key: "zulu", units: [
    unit({ stage_key: "zulu", unit_id: "p" }),
    unit({ stage_key: "zulu", unit_id: "q", work_orders: [orderQ] }),
  ] });
  const reversedSnap = snapshot({ stages: [reversedZulu, reversedAlpha] });
  const reversed = derive(reversedSnap);
  expect(reversed).toEqual(first);
  expect(first.ok && first.value.commands).toEqual([
    { kind: "start_work", work_order_id: orderY.id, run_unit_id: runUnitIdForTest("alpha", "y") },
    { kind: "start_work", work_order_id: orderQ.id, run_unit_id: runUnitIdForTest("zulu", "q") },
  ]);
});

// -----------------------------------------------------------------------
// 13. a stage with no row and inputs ready → materialize_stage followed by one materialize_unit per driver artifact.

test("case 13: a stage with no row materializes once per driver artifact, in artifact order", () => {
  const definition = fanOutDefinition({ stage_key: "build", over_input: "brief" });
  const versioningBrief = availableBrief("versioning", []);
  const schemaBrief = availableBrief("schema", []);
  const snap = snapshot({ definition, available_artifacts: [versioningBrief, schemaBrief] });

  const result = derive(snap);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.commands.map((command) => command.kind)).toEqual(["materialize_stage", "materialize_unit", "materialize_unit"]);
  const minted = result.value.commands.filter((command): command is Extract<Command, { kind: "materialize_unit" }> => command.kind === "materialize_unit");
  expect(minted.map((command) => command.unit_id)).toEqual(["versioning" as UnitId, "schema" as UnitId]);
});

// -----------------------------------------------------------------------
// 14. stage closed and every unit satisfied → mark_stage_succeeded.

test("case 14: a closed stage whose units are all satisfied succeeds", () => {
  const snap = snapshot({
    definition: emptyDefinition(),
    stages: [stage({ stage_key: "build", materialization_closed: true, units: [unit({ stage_key: "build", unit_id: "u", state: "satisfied", required_slots: [releasedSlot()] })] })],
  });
  expect(derive(snap)).toEqual({ ok: true, value: { commands: [{ kind: "mark_stage_succeeded", stage_instance_id: snap.stages[0]!.id }] } });
});

// -----------------------------------------------------------------------
// 15. every definition stage stored with state succeeded → complete_run(succeeded).

test("case 15: every definition stage stored as succeeded completes the run", () => {
  const definition = scalarStageDefinition(["a", "b"]);
  const snap = snapshot({
    definition,
    stages: [
      stage({ stage_key: "a", state: "succeeded", materialization_closed: true, units: [] }),
      stage({ stage_key: "b", state: "succeeded", materialization_closed: true, units: [] }),
    ],
  });
  expect(derive(snap)).toEqual({ ok: true, value: { commands: [{ kind: "complete_run", outcome: { kind: "succeeded" } }] } });
});

// -----------------------------------------------------------------------
// 16. a stored stage already succeeded gets no mark_stage_succeeded again.

test("case 16: an already-succeeded stage is never re-marked succeeded", () => {
  const definition = scalarStageDefinition(["build"]);
  const snap = snapshot({
    definition,
    stages: [stage({ stage_key: "build", state: "succeeded", materialization_closed: true, units: [unit({ stage_key: "build", unit_id: "u", state: "satisfied", required_slots: [releasedSlot()] })] })],
  });
  expect(derive(snap)).toEqual({ ok: true, value: { commands: [{ kind: "complete_run", outcome: { kind: "succeeded" } }] } });
});
