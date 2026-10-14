import { expect, test } from "bun:test";
import { selectRunStalls, selectStalledWorkers } from "../src/projections/attention";
import type { CommitFaultNotice } from "../src/projections/operator-event";
import type { AttemptRecord, RunRecord, UnitRecord } from "../src/storage/schema-records";

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

// ------------------------------------------------------------ run stalls -----

const stallSources = (fields: Partial<Parameters<typeof selectRunStalls>[0]> = {}): Parameters<typeof selectRunStalls>[0] => ({
  run: { id: "run", root_unit_id: "run", status: { kind: "active" } } as RunRecord,
  units: [{ id: "run" }, { id: "run/plan" }, { id: "run/work" }] as UnitRecord[],
  stalls: [{ unit_id: "run/plan", ingress_id: "i1", reason: "run stalled at run/work: duplicate key",
    stall: { unit_id: "run/work", event: { kind: "cancel_requested" }, after_event: "e1", refused_at: "2026-10-13T00:00:00.000Z" } }],
  faults: [],
  latest_events: [{ unit_id: "run/plan", event_id: "e1", created_at: new Date(1) }],
  ...fields,
});

test("a stall stands on the unit advancing stopped at while nothing has committed on the refused event's unit since", () => {
  expect(selectRunStalls(stallSources()).map((stall) => [stall.kind, stall.unit_id])).toEqual([["stalled", "run/work"]]);
});

test("an event committed on the refused event's unit since ends the stall", () => {
  const latest_events = [{ unit_id: "run/plan", event_id: "e2", created_at: new Date(2) }];
  expect(selectRunStalls(stallSources({ latest_events }))).toEqual([]);
});

test("an event committed on another unit leaves the stall standing", () => {
  const latest_events = [{ unit_id: "run/plan", event_id: "e1", created_at: new Date(1) }, { unit_id: "run/watch", event_id: "e2", created_at: new Date(2) }];
  expect(selectRunStalls(stallSources({ latest_events })).length).toBe(1);
});

test("a finished run has no stall", () => {
  const run = { id: "run", root_unit_id: "run", status: { kind: "cancelled" } } as RunRecord;
  expect(selectRunStalls(stallSources({ run }))).toEqual([]);
});

const refusedAt = (minute: number) => `2026-10-13T00:0${minute}:00.000Z`;
const fault = (fields: Partial<CommitFaultNotice>, minute: number) => ({ recorded_at: new Date(refusedAt(minute)),
  notice: { run_id: "run", unit_id: null, at_unit: null, ingress_id: "f1", event: { kind: "cancel_requested" }, detail: "checked stage absent",
    after_event: "e1", ...fields } as CommitFaultNotice });

test("refusals repeating one stall show once, and a fault on a whole-run event shows on the root", () => {
  const [stall] = stallSources().stalls;
  const again = { ...stall!, ingress_id: "i2", stall: { ...stall!.stall, refused_at: refusedAt(1) } };
  expect(selectRunStalls(stallSources({ stalls: [stall!, again], faults: [fault({ ingress_id: "i3" }, 2)] }))
    .map((item) => [item.kind, item.unit_id, item.ingress_id])).toEqual([["stalled", "run/work", "i2"], ["faulted", "run", "i3"]]);
});

test("a stall repeated after another moves to the end, so the newest is last", () => {
  const [stall] = stallSources().stalls;
  const at = (minute: number, ingress_id: string) => ({ ...stall!, ingress_id, stall: { ...stall!.stall, refused_at: refusedAt(minute) } });
  const between = fault({ ingress_id: "f1", unit_id: "run/plan" as CommitFaultNotice["unit_id"] }, 1);
  expect(selectRunStalls(stallSources({ stalls: [at(0, "i1"), at(2, "i2")], faults: [between] })).map((item) => item.ingress_id))
    .toEqual(["f1", "i2"]);
});

test("a fault the core found advancing another unit shows on that unit", () => {
  const found = fault({ unit_id: "run/plan" as CommitFaultNotice["unit_id"], at_unit: "run/work" as CommitFaultNotice["at_unit"] }, 1);
  expect(selectRunStalls(stallSources({ stalls: [], faults: [found] })).map((item) => [item.kind, item.unit_id])).toEqual([["faulted", "run/work"]]);
});
