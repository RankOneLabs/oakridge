import { describe, expect, it } from "vitest";

import type { ParkedGate, RunDetail, RunSessionAttempt, StageDetail } from "../types";
import {
  RECENT_SLOT_RELEASE_LIMIT,
  selectRunGatesRead,
  selectRunOverview,
  selectRunSidebarSessions,
  selectUnitsAwaitingAction,
  unitActionKeyOf,
  type RunOverview,
  type RunOverviewGates,
} from "./run-overview";

const stage = (overrides: Partial<StageDetail> & Pick<StageDetail, "name" | "status">): StageDetail => ({
  stage_instance_id: `si-${overrides.name}`,
  type: "delegated_session",
  artifacts: [],
  delegated_kbbl_sid: null,
  worktree: null,
  ...overrides,
});

const attempt = (
  overrides: Partial<RunSessionAttempt> & Pick<RunSessionAttempt, "work_order_id" | "session_id" | "unit_id">,
): RunSessionAttempt => ({
  stage_instance_id: "si-build",
  stage_key: "build",
  reason: "initial",
  work_order_state: "started",
  created_at: "2026-09-01T09:00:00Z",
  completed_at: null,
  executor_health_kind: null,
  cleanup_state: "pending",
  ...overrides,
});

const gate = (overrides: Partial<ParkedGate> & Pick<ParkedGate, "id" | "unit_id">): ParkedGate => ({
  gate_type: "artifact_review",
  gate_step: null,
  run_id: "run-1",
  stage_name: "build",
  artifact_revision_id: null,
  worktree: null,
  resume_actions: ["approve", "reject"],
  run_state: "active",
  actionable: true,
  ...overrides,
});

const run = (overrides: Partial<RunDetail> = {}): RunDetail => ({
  id: "run-1",
  title: "Ship the run command center",
  repository_keys: ["oakridge"],
  workflow_name: "dev_flow_v2",
  status: "parked",
  is_stuck: false,
  parked_count: 1,
  updated_at: "2026-09-01T10:00:00Z",
  stages: [
    stage({ name: "plan", status: "complete" }),
    stage({ name: "build", status: "parked" }),
    stage({ name: "assess", status: "pending" }),
  ],
  ...overrides,
});

interface OverviewInput {
  readonly run?: RunDetail;
  readonly sessions?: readonly RunSessionAttempt[];
  /** The gate list the read produced; the read itself is exercised separately. */
  readonly gates?: readonly ParkedGate[];
}

const overviewOf = ({ gates = [], ...input }: OverviewInput = {}): RunOverview =>
  selectRunOverview({ run: run(), sessions: [], ...input, gates: { kind: "loaded", gates } });

/** The gate-derived half of an overview, or a failure naming what it got instead. */
const knownGates = (overview: RunOverview): Extract<RunOverviewGates, { kind: "known" }> => {
  if (overview.gates.kind !== "known") {
    throw new Error(`expected a loaded gate read, got "${overview.gates.kind}"`);
  }
  return overview.gates;
};

describe("run status", () => {
  it("carries the run's own status, stuck flag and parked count", () => {
    const overview = overviewOf({ run: run({ status: "failed", is_stuck: true, parked_count: 3 }) });

    expect(overview.status).toBe("failed");
    expect(overview.is_stuck).toBe(true);
    expect(overview.parked_count).toBe(3);
  });
});

describe("current session", () => {
  it("is the newest current attempt that is actually executing", () => {
    const overview = overviewOf({
      sessions: [
        attempt({ work_order_id: "wo-1", session_id: "sid-1", unit_id: "c1", work_order_state: "completed" }),
        attempt({ work_order_id: "wo-2", session_id: "sid-2", unit_id: "c2" }),
      ],
    });

    expect(overview.current_session?.session_id).toBe("sid-2");
    expect(overview.current_session?.attempt_label).toBe("attempt 1");
  });

  it("is null when no attempt is executing", () => {
    const overview = overviewOf({
      sessions: [attempt({ work_order_id: "wo-1", session_id: "sid-1", unit_id: "c1", work_order_state: "completed" })],
    });

    expect(overview.current_session).toBeNull();
  });

  it("never names a superseded attempt", () => {
    const overview = overviewOf({
      sessions: [
        attempt({ work_order_id: "wo-1", session_id: "sid-old", unit_id: "c1", work_order_state: "abandoned" }),
        attempt({ work_order_id: "wo-2", session_id: "sid-new", unit_id: "c1", reason: "operator_retry" }),
      ],
    });

    expect(overview.current_session?.session_id).toBe("sid-new");
    expect(overview.current_session?.attempt_label).toBe("attempt 2 of 2");
  });
});

describe("sessions awaiting action", () => {
  it("names the current attempt of every unit holding an actionable gate", () => {
    const overview = overviewOf({
      sessions: [
        attempt({ work_order_id: "wo-1", session_id: "sid-1", unit_id: "c1" }),
        attempt({ work_order_id: "wo-2", session_id: "sid-2", unit_id: "c2" }),
      ],
      gates: [gate({ id: "gate-1", unit_id: "c2" })],
    });

    expect(knownGates(overview).sessions_awaiting_action.map((ref) => ref.session_id)).toEqual([
      "sid-2",
    ]);
  });

  it("ignores a stranded gate the run has already moved past", () => {
    const overview = overviewOf({
      sessions: [attempt({ work_order_id: "wo-1", session_id: "sid-1", unit_id: "c1" })],
      gates: [gate({ id: "gate-1", unit_id: "c1", actionable: false })],
    });

    expect(knownGates(overview).sessions_awaiting_action).toEqual([]);
  });

  it("keys a gate and an attempt on the same unit identically", () => {
    const keys = selectUnitsAwaitingAction([gate({ id: "gate-1", unit_id: "c2" })]);

    expect(keys.has(unitActionKeyOf("build", "c2"))).toBe(true);
    expect(keys.has(unitActionKeyOf("assess", "c2"))).toBe(false);
  });
});

describe("active gates", () => {
  it("lists only gates a decision can still take effect on", () => {
    const overview = overviewOf({
      gates: [
        gate({ id: "gate-open", unit_id: "c1" }),
        gate({ id: "gate-stranded", unit_id: "c2", actionable: false }),
      ],
    });

    const active = knownGates(overview).active;
    expect(active.map((entry) => entry.gate_id)).toEqual(["gate-open"]);
    expect(active[0].resume_actions).toEqual(["approve", "reject"]);
  });
});

describe("the gate read", () => {
  it("keeps a payload it already has when a later poll fails", () => {
    const gates = [gate({ id: "gate-1", unit_id: "c1" })];

    expect(selectRunGatesRead({ gates, is_pending: false, is_error: true })).toEqual({
      kind: "loaded",
      gates,
    });
  });

  it("is unavailable when the read failed before producing anything", () => {
    expect(selectRunGatesRead({ gates: undefined, is_pending: false, is_error: true })).toEqual({
      kind: "unavailable",
    });
  });

  it("is pending rather than empty while the first read is in flight", () => {
    expect(selectRunGatesRead({ gates: undefined, is_pending: true, is_error: false })).toEqual({
      kind: "pending",
    });
  });
});

describe("an unavailable gate read", () => {
  const unreadOverview = () =>
    selectRunOverview({
      run: run(),
      sessions: [attempt({ work_order_id: "wo-1", session_id: "sid-1", unit_id: "c1" })],
      gates: { kind: "unavailable" },
    });

  it("never reports an empty gate list the overview could render as 'no gate is open'", () => {
    expect(unreadOverview().gates).toEqual({ kind: "unavailable" });
  });

  it("still reports the run's own status, which does not come from the gate list", () => {
    const overview = unreadOverview();

    expect(overview.parked_count).toBe(1);
    expect(overview.current_session?.session_id).toBe("sid-1");
  });

  it("tells the sidebar its action markers are unknown rather than absent", () => {
    const view = selectRunSidebarSessions({
      sessions: { kind: "loaded", attempts: [attempt({ work_order_id: "wo-1", session_id: "sid-1", unit_id: "c1" })] },
      gates: { kind: "unavailable" },
      purgedSessionIds: new Set(),
    });

    expect(view.is_action_state_known).toBe(false);
    expect(view.rows.map((row) => row.requires_operator_action)).toEqual([false]);
  });
});

describe("sidebar sessions", () => {
  it("marks the current attempt of a unit holding an actionable gate", () => {
    const view = selectRunSidebarSessions({
      sessions: { kind: "loaded", attempts: [
        attempt({ work_order_id: "wo-1", session_id: "sid-1", unit_id: "c1" }),
        attempt({ work_order_id: "wo-2", session_id: "sid-2", unit_id: "c2" }),
      ] },
      gates: { kind: "loaded", gates: [gate({ id: "gate-1", unit_id: "c2" })] },
      purgedSessionIds: new Set(),
    });

    expect(view.is_action_state_known).toBe(true);
    expect(view.rows.filter((row) => row.requires_operator_action).map((row) => row.session_id)).toEqual([
      "sid-2",
    ]);
  });

  it("drops a purged session, since the run keeps listing its work order", () => {
    const view = selectRunSidebarSessions({
      sessions: { kind: "loaded", attempts: [
        attempt({ work_order_id: "wo-1", session_id: "sid-1", unit_id: "c1" }),
        attempt({ work_order_id: "wo-2", session_id: "sid-2", unit_id: "c2" }),
      ] },
      gates: { kind: "loaded", gates: [] },
      purgedSessionIds: new Set(["sid-1"]),
    });

    expect(view.rows.map((row) => row.session_id)).toEqual(["sid-2"]);
  });

  it("leaves a surviving attempt's number alone when an earlier attempt is purged", () => {
    const view = selectRunSidebarSessions({
      sessions: { kind: "loaded", attempts: [
        attempt({
          work_order_id: "wo-1",
          session_id: "sid-1",
          unit_id: "c1",
          created_at: "2026-09-01T09:00:00Z",
          work_order_state: "abandoned",
        }),
        attempt({
          work_order_id: "wo-2",
          session_id: "sid-2",
          unit_id: "c1",
          created_at: "2026-09-01T10:00:00Z",
          reason: "operator_retry",
        }),
      ] },
      gates: { kind: "loaded", gates: [] },
      purgedSessionIds: new Set(["sid-1"]),
    });

    // The purge took the transcript, not the attempt that produced it — the
    // retry is still the unit's second try and says so.
    expect(view.rows.map((row) => row.attempt_label)).toEqual(["attempt 2 of 2"]);
  });

  it("gives two attempts sharing a session id distinct row identities", () => {
    // `executor_attachment.work_order_id` is the primary key, so a session id
    // reattached to a second work order is unexpected but not prevented. A row
    // list keyed on `session_id` would collapse the two.
    const view = selectRunSidebarSessions({
      sessions: {
        kind: "loaded",
        attempts: [
          attempt({ work_order_id: "wo-1", session_id: "sid-1", unit_id: "c1", work_order_state: "abandoned" }),
          attempt({ work_order_id: "wo-2", session_id: "sid-1", unit_id: "c1", reason: "operator_retry" }),
        ],
      },
      gates: { kind: "loaded", gates: [] },
      purgedSessionIds: new Set(),
    });

    expect(view.rows.map((row) => row.work_order_id)).toEqual(["wo-1", "wo-2"]);
  });

  it("says the list is unknown rather than showing a failed read as no sessions", () => {
    const view = selectRunSidebarSessions({
      sessions: { kind: "unavailable" },
      gates: { kind: "loaded", gates: [] },
      purgedSessionIds: new Set(),
    });

    expect(view.is_session_list_known).toBe(false);
    expect(view.rows).toEqual([]);
  });

  it("reports a genuinely empty run as known and empty", () => {
    const view = selectRunSidebarSessions({
      sessions: { kind: "loaded", attempts: [] },
      gates: { kind: "loaded", gates: [] },
      purgedSessionIds: new Set(),
    });

    expect(view.is_session_list_known).toBe(true);
    expect(view.rows).toEqual([]);
  });
});

describe("recent slot releases", () => {
  it("orders releases by created_at descending across stages", () => {
    const overview = overviewOf({
      run: run({
        stages: [
          stage({
            name: "plan",
            status: "complete",
            artifacts: [{ id: "art-plan", type_id: "dev.plan", version: 1, created_at: "2026-09-01T08:00:00Z" }],
          }),
          stage({
            name: "build",
            status: "running",
            artifacts: [
              { id: "art-build-a", type_id: "dev.build_result", version: 1, created_at: "2026-09-01T09:30:00Z" },
              { id: "art-build-b", type_id: "dev.build_result", version: 2, created_at: "2026-09-01T09:00:00Z" },
            ],
          }),
        ],
      }),
    });

    expect(overview.recent_slot_releases.map((release) => release.artifact_id)).toEqual([
      "art-build-a",
      "art-build-b",
      "art-plan",
    ]);
  });

  it("compares the instant rather than the rendered offset across a DST fold", () => {
    const overview = overviewOf({
      run: run({
        stages: [
          stage({
            name: "build",
            status: "running",
            artifacts: [
              { id: "art-earlier", type_id: "dev.build_result", version: 1, created_at: "2026-11-01T01:30:00-04:00" },
              { id: "art-later", type_id: "dev.build_result", version: 2, created_at: "2026-11-01T01:15:00-05:00" },
            ],
          }),
        ],
      }),
    });

    expect(overview.recent_slot_releases.map((release) => release.artifact_id)).toEqual([
      "art-later",
      "art-earlier",
    ]);
  });

  it("sorts a release with no timestamp last rather than first", () => {
    const overview = overviewOf({
      run: run({
        stages: [
          stage({
            name: "build",
            status: "running",
            artifacts: [
              { id: "art-undated", type_id: "dev.build_result", version: 1 },
              { id: "art-dated", type_id: "dev.build_result", version: 2, created_at: "2026-09-01T09:00:00Z" },
            ],
          }),
        ],
      }),
    });

    expect(overview.recent_slot_releases.map((release) => release.artifact_id)).toEqual([
      "art-dated",
      "art-undated",
    ]);
  });

  it("caps the list so that recent keeps meaning recent", () => {
    const artifacts = Array.from({ length: RECENT_SLOT_RELEASE_LIMIT + 4 }, (_unused, index) => ({
      id: `art-${index}`,
      type_id: "dev.build_result",
      version: index + 1,
      created_at: `2026-09-0${(index % 9) + 1}T09:00:00Z`,
    }));
    const overview = overviewOf({
      run: run({ stages: [stage({ name: "build", status: "running", artifacts })] }),
    });

    expect(overview.recent_slot_releases).toHaveLength(RECENT_SLOT_RELEASE_LIMIT);
  });
});

describe("stage progress", () => {
  it("counts every stage by status", () => {
    const overview = overviewOf();

    expect(overview.stage_progress).toEqual({
      total: 3,
      complete: 1,
      parked: 1,
      pending: 1,
      running: 0,
      failed: 0,
    });
  });

  it("reports an empty run as zero of zero rather than throwing", () => {
    const overview = overviewOf({ run: run({ stages: [] }) });

    expect(overview.stage_progress.total).toBe(0);
    expect(overview.stage_progress.complete).toBe(0);
  });
});
