import { expect, test } from "bun:test";
import { selectStalledWorkers } from "../src/projections/attention";
import type { AttemptRecord, UnitRecord } from "../src/storage/schema-records";

const unit = { id: "run/analysis", status: { kind: "active" } } as Pick<UnitRecord, "id" | "status">;
const attempt = (fields: Partial<AttemptRecord>): AttemptRecord => ({ action_id: "a1", seq: 1, run_id: "run", unit_id: "run/analysis", worker: "writer",
  mode: { kind: "initial" }, cause: { kind: "missing" }, status: { kind: "pending" }, ended_at: null, kbbl_session_id: null,
  publication_secret_hash: null, created_at: new Date(0), ...fields } as AttemptRecord);
const failed = attempt({ status: { kind: "failed", code: "worker_exit", detail: "session stopped" }, ended_at: 1 });

test("an active unit's worker whose latest attempt failed, with nothing wanted for it, is stalled", () => {
  expect(selectStalledWorkers({ units: [unit], attempts: [failed], retries: [], wanted: [{ unit_id: unit.id, actions: [] }] })).toEqual([
    { unit_id: "run/analysis", worker: "writer", action_id: "a1", seq: 1, code: "worker_exit", detail: "session stopped" },
  ]);
});

test("a pending retry clears the stall for its worker", () => {
  const retry = attempt({ action_id: "a2" as AttemptRecord["action_id"], cause: { kind: "retry", event: "e1" } });
  expect(selectStalledWorkers({ units: [unit], attempts: [failed, retry], retries: [{ unit_id: unit.id, worker: "writer", retry_id: "e1" }], wanted: [] })).toEqual([]);
});

test("a worker the latest wanted set still wants is not stalled", () => {
  const wanted = [{ unit_id: unit.id, actions: [{ kind: "run_worker" as const, unit: unit.id, worker: "writer", mode: { kind: "initial" as const }, cause: { kind: "missing" as const } }] }];
  expect(selectStalledWorkers({ units: [unit], attempts: [failed], retries: [], wanted })).toEqual([]);
});

test("a failed attempt on a unit that is no longer active is not a stall", () => {
  const done = { ...unit, status: { kind: "done", outcome: {} } } as Pick<UnitRecord, "id" | "status">;
  expect(selectStalledWorkers({ units: [done], attempts: [failed], retries: [], wanted: [] })).toEqual([]);
});
