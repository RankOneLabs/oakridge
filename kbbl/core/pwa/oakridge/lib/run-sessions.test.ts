import { describe, expect, it } from "vitest";

import type { RunSessionAttempt } from "../types";
import { runUnitKeyOf, selectRunSessionRows } from "./run-sessions";

const attempt = (overrides: Partial<RunSessionAttempt> & Pick<RunSessionAttempt, "work_order_id" | "created_at">): RunSessionAttempt => ({
  session_id: `session-${overrides.work_order_id}`,
  stage_instance_id: "stage-1",
  stage_key: "build",
  unit_id: "api",
  reason: "initial",
  work_order_state: "completed",
  completed_at: null,
  executor_health_kind: null,
  cleanup_state: "not_needed",
  ...overrides,
});

const currentWorkOrderIds = (attempts: readonly RunSessionAttempt[]): string[] =>
  selectRunSessionRows(attempts).filter((row) => row.is_current).map((row) => row.attempt.work_order_id);

describe("selectRunSessionRows", () => {
  it("marks a unit's only attempt as current", () => {
    const rows = selectRunSessionRows([attempt({ work_order_id: "work-1", created_at: "2026-09-01T00:00:00Z", work_order_state: "started" })]);
    expect(rows.map((row) => ({ id: row.attempt.work_order_id, is_current: row.is_current, of: row.attempt_count })))
      .toEqual([{ id: "work-1", is_current: true, of: 1 }]);
  });

  it("picks the newest non-abandoned attempt when a newer one was abandoned", () => {
    // Three attempts at one unit; the newest was abandoned, so the started
    // middle attempt is what the unit currently is.
    const attempts = [
      attempt({ work_order_id: "work-1", created_at: "2026-09-01T00:00:00Z", work_order_state: "completed", completed_at: "2026-09-01T01:00:00Z" }),
      attempt({ work_order_id: "work-2", created_at: "2026-09-02T00:00:00Z", work_order_state: "started", reason: "operator_retry" }),
      attempt({ work_order_id: "work-3", created_at: "2026-09-03T00:00:00Z", work_order_state: "abandoned", reason: "operator_retry", completed_at: "2026-09-03T01:00:00Z" }),
    ];
    expect(currentWorkOrderIds(attempts)).toEqual(["work-2"]);
  });

  it("picks the newest by created_at when every attempt completed", () => {
    const attempts = [
      attempt({ work_order_id: "work-1", created_at: "2026-09-01T00:00:00Z", completed_at: "2026-09-01T01:00:00Z" }),
      attempt({ work_order_id: "work-2", created_at: "2026-09-02T00:00:00Z", reason: "operator_retry", completed_at: "2026-09-02T01:00:00Z" }),
    ];
    expect(currentWorkOrderIds(attempts)).toEqual(["work-2"]);
  });

  it("falls back to the newest attempt when every attempt was abandoned", () => {
    const attempts = [
      attempt({ work_order_id: "work-1", created_at: "2026-09-01T00:00:00Z", work_order_state: "abandoned", completed_at: "2026-09-01T01:00:00Z" }),
      attempt({ work_order_id: "work-2", created_at: "2026-09-02T00:00:00Z", work_order_state: "abandoned", completed_at: "2026-09-02T01:00:00Z" }),
    ];
    expect(currentWorkOrderIds(attempts)).toEqual(["work-2"]);
  });

  it("resolves each unit independently", () => {
    const attempts = [
      attempt({ work_order_id: "work-1", created_at: "2026-09-01T00:00:00Z", unit_id: "api" }),
      attempt({ work_order_id: "work-2", created_at: "2026-09-02T00:00:00Z", unit_id: "web", work_order_state: "started" }),
    ];
    expect(currentWorkOrderIds(attempts)).toEqual(["work-1", "work-2"]);
  });

  it("numbers attempts within their own unit, oldest first", () => {
    const attempts = [
      attempt({ work_order_id: "work-1", created_at: "2026-09-01T00:00:00Z", unit_id: "api" }),
      attempt({ work_order_id: "work-2", created_at: "2026-09-02T00:00:00Z", unit_id: "web" }),
      attempt({ work_order_id: "work-3", created_at: "2026-09-03T00:00:00Z", unit_id: "api", reason: "operator_retry" }),
    ];
    expect(selectRunSessionRows(attempts).map((row) => `${row.attempt.unit_id} ${row.attempt_number}/${row.attempt_count}`))
      .toEqual(["api 1/2", "web 1/1", "api 2/2"]);
  });

  it("preserves the order the run returned", () => {
    const attempts = [
      attempt({ work_order_id: "work-1", created_at: "2026-09-01T00:00:00Z" }),
      attempt({ work_order_id: "work-2", created_at: "2026-09-02T00:00:00Z" }),
    ];
    expect(selectRunSessionRows(attempts).map((row) => row.attempt.work_order_id)).toEqual(["work-1", "work-2"]);
  });

  it("has no rows for a run that opened no sessions", () => {
    expect(selectRunSessionRows([])).toEqual([]);
  });
});

describe("runUnitKeyOf", () => {
  /** `unit_id` alone collides across stages — a fan-out mints unit ids per stage instance. */
  it("distinguishes same-named units in different stages", () => {
    const build = attempt({ work_order_id: "work-1", created_at: "2026-09-01T00:00:00Z", stage_instance_id: "stage-1", unit_id: "0" });
    const assess = attempt({ work_order_id: "work-2", created_at: "2026-09-02T00:00:00Z", stage_instance_id: "stage-2", unit_id: "0" });
    expect(runUnitKeyOf(build)).not.toBe(runUnitKeyOf(assess));
    expect(currentWorkOrderIds([build, assess])).toEqual(["work-1", "work-2"]);
  });
});
