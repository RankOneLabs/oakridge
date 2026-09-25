import { describe, expect, it } from "vitest";

import type { RunSessionAttempt } from "../types";
import { runUnitKeyOf, selectRunSessionRows, selectRunSessionsRead } from "./run-sessions";

// Timestamps are written the way the route actually sends them — Postgres
// `timestamptz::text`, so a space separator and a numeric offset, not ISO-8601
// with a `T` and a `Z`. Fixtures in the tidier format hid that these values are
// rendered in an unpinned session timezone.
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
    const rows = selectRunSessionRows([attempt({ work_order_id: "work-1", created_at: "2026-09-01 00:00:00+00", work_order_state: "started" })]);
    expect(rows.map((row) => ({ id: row.attempt.work_order_id, is_current: row.is_current, of: row.attempt_count })))
      .toEqual([{ id: "work-1", is_current: true, of: 1 }]);
  });

  it("picks the newest non-abandoned attempt when a newer one was abandoned", () => {
    // Three attempts at one unit; the newest was abandoned, so the started
    // middle attempt is what the unit currently is.
    const attempts = [
      attempt({ work_order_id: "work-1", created_at: "2026-09-01 00:00:00+00", work_order_state: "completed", completed_at: "2026-09-01 01:00:00+00" }),
      attempt({ work_order_id: "work-2", created_at: "2026-09-02 00:00:00+00", work_order_state: "started", reason: "operator_retry" }),
      attempt({ work_order_id: "work-3", created_at: "2026-09-03 00:00:00+00", work_order_state: "abandoned", reason: "operator_retry", completed_at: "2026-09-03 01:00:00+00" }),
    ];
    expect(currentWorkOrderIds(attempts)).toEqual(["work-2"]);
  });

  it("picks the run's last attempt when every attempt completed", () => {
    const attempts = [
      attempt({ work_order_id: "work-1", created_at: "2026-09-01 00:00:00+00", completed_at: "2026-09-01 01:00:00+00" }),
      attempt({ work_order_id: "work-2", created_at: "2026-09-02 00:00:00+00", reason: "operator_retry", completed_at: "2026-09-02 01:00:00+00" }),
    ];
    expect(currentWorkOrderIds(attempts)).toEqual(["work-2"]);
  });

  /**
   * The route orders by real timestamp in Postgres, but renders `created_at`
   * through an unpinned session timezone. Across a DST fall-back the later
   * attempt carries the smaller string: `01:15:00-05` is 06:15 UTC, 45 minutes
   * after `01:30:00-04`'s 05:30 UTC, yet sorts first. Selecting by string
   * comparison picked `work-1` here.
   */
  it("takes the run's order as authoritative across a DST fold", () => {
    const attempts = [
      attempt({ work_order_id: "work-1", created_at: "2026-11-01 01:30:00-04" }),
      attempt({ work_order_id: "work-2", created_at: "2026-11-01 01:15:00-05", reason: "operator_retry", work_order_state: "started" }),
    ];
    expect(currentWorkOrderIds(attempts)).toEqual(["work-2"]);
  });

  it("falls back to the newest attempt when every attempt was abandoned", () => {
    const attempts = [
      attempt({ work_order_id: "work-1", created_at: "2026-09-01 00:00:00+00", work_order_state: "abandoned", completed_at: "2026-09-01 01:00:00+00" }),
      attempt({ work_order_id: "work-2", created_at: "2026-09-02 00:00:00+00", work_order_state: "abandoned", completed_at: "2026-09-02 01:00:00+00" }),
    ];
    expect(currentWorkOrderIds(attempts)).toEqual(["work-2"]);
  });

  it("resolves each unit independently", () => {
    const attempts = [
      attempt({ work_order_id: "work-1", created_at: "2026-09-01 00:00:00+00", unit_id: "api" }),
      attempt({ work_order_id: "work-2", created_at: "2026-09-02 00:00:00+00", unit_id: "web", work_order_state: "started" }),
    ];
    expect(currentWorkOrderIds(attempts)).toEqual(["work-1", "work-2"]);
  });

  it("numbers attempts within their own unit, oldest first", () => {
    const attempts = [
      attempt({ work_order_id: "work-1", created_at: "2026-09-01 00:00:00+00", unit_id: "api" }),
      attempt({ work_order_id: "work-2", created_at: "2026-09-02 00:00:00+00", unit_id: "web" }),
      attempt({ work_order_id: "work-3", created_at: "2026-09-03 00:00:00+00", unit_id: "api", reason: "operator_retry" }),
    ];
    expect(selectRunSessionRows(attempts).map((row) => `${row.attempt.unit_id} ${row.attempt_number}/${row.attempt_count}`))
      .toEqual(["api 1/2", "web 1/1", "api 2/2"]);
  });

  it("preserves the order the run returned", () => {
    const attempts = [
      attempt({ work_order_id: "work-1", created_at: "2026-09-01 00:00:00+00" }),
      attempt({ work_order_id: "work-2", created_at: "2026-09-02 00:00:00+00" }),
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
    const build = attempt({ work_order_id: "work-1", created_at: "2026-09-01 00:00:00+00", stage_instance_id: "stage-1", unit_id: "0" });
    const assess = attempt({ work_order_id: "work-2", created_at: "2026-09-02 00:00:00+00", stage_instance_id: "stage-2", unit_id: "0" });
    expect(runUnitKeyOf(build)).not.toBe(runUnitKeyOf(assess));
    expect(currentWorkOrderIds([build, assess])).toEqual(["work-1", "work-2"]);
  });
});

describe("selectRunSessionsRead", () => {
  const ATTEMPTS = [attempt({ work_order_id: "work-1", created_at: "2026-09-01 00:00:00+00" })];

  it("is pending rather than empty while the first read is in flight", () => {
    expect(selectRunSessionsRead({ attempts: undefined, is_pending: true, is_error: false }))
      .toEqual({ kind: "pending" });
  });

  it("is unavailable when the read failed before producing anything", () => {
    expect(selectRunSessionsRead({ attempts: undefined, is_pending: false, is_error: true }))
      .toEqual({ kind: "unavailable" });
  });

  it("keeps a payload it already has when a later poll fails", () => {
    // The attempts did not stop existing because a background refetch timed
    // out, and dropping to unavailable would flicker the pane arrangement.
    expect(selectRunSessionsRead({ attempts: ATTEMPTS, is_pending: false, is_error: true }))
      .toEqual({ kind: "loaded", attempts: ATTEMPTS });
  });

  it("reads a settled empty response as a run with no sessions", () => {
    expect(selectRunSessionsRead({ attempts: [], is_pending: false, is_error: false }))
      .toEqual({ kind: "loaded", attempts: [] });
  });
});
