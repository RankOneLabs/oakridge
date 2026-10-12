import { expect, test } from "bun:test";
import type { ScopedSnapshot } from "../src/core-client/core-types";
import { selectInspectAttention } from "../src/projections/run-view";

test("active unit with a failed worker names that worker in inspect attention", () => {
  const snapshot: ScopedSnapshot = {
    run: { id: "run", root: "run", status: { kind: "active" } },
    units: [{ id: "run/analysis", parent: "run", declaration: "analysis", stage: "analysis",
      status: { kind: "active" }, input: {}, after: [] }],
    attempts: [{ action_id: "run/analysis:writer", seq: 1, unit: "run/analysis", worker: "writer",
      mode: { kind: "initial" }, cause: { kind: "missing" }, status: { kind: "failed", code: "worker_exit", detail: "session stopped" }, ended_at: 1 }],
    revisions: [], decisions: [], retry_events: [],
  };
  expect(selectInspectAttention(snapshot, [{ unit_id: "run/analysis", actions: [] }])).toEqual([
    { kind: "stalled_worker", unit_id: "run/analysis", worker: "writer", action_id: "run/analysis:writer", detail: "session stopped" },
  ]);
});

test("a pending retry clears stalled attention for its worker", () => {
  const snapshot: ScopedSnapshot = {
    run: { id: "run", root: "run", status: { kind: "active" } },
    units: [{ id: "run/analysis", parent: "run", declaration: "analysis", stage: "analysis",
      status: { kind: "active" }, input: {}, after: [] }],
    attempts: [
      { action_id: "old", seq: 1, unit: "run/analysis", worker: "writer", mode: { kind: "initial" },
        cause: { kind: "missing" }, status: { kind: "failed", code: "exit", detail: "failed" }, ended_at: 1 },
      { action_id: "retry", seq: 1, unit: "run/analysis", worker: "writer", mode: { kind: "initial" },
        cause: { kind: "retry", event: "event" }, status: { kind: "pending" }, ended_at: null },
    ],
    revisions: [], decisions: [], retry_events: [],
  };
  expect(selectInspectAttention(snapshot, [{ unit_id: "run/analysis", actions: [] }])).toEqual([]);
  expect(selectInspectAttention({ ...snapshot, retry_events: [["run/analysis", "writer", "event"]],
    attempts: [snapshot.attempts[0]!, { ...snapshot.attempts[1]!, status: { kind: "succeeded" }, ended_at: 1 }] },
  [{ unit_id: "run/analysis", actions: [] }])).toEqual([]);
});
