import { describe, expect, it } from "vitest";

import type { ParkedGate, RunDetail, RunSessionAttempt, StageDetail } from "../types";
import {
  RECENT_SLOT_RELEASE_LIMIT,
  selectRunOverview,
  selectUnitsAwaitingAction,
  unitActionKeyOf,
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

const overviewOf = (input: Partial<Parameters<typeof selectRunOverview>[0]> = {}) =>
  selectRunOverview({ run: run(), sessions: [], gates: [], ...input });

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

    expect(overview.sessions_awaiting_action.map((ref) => ref.session_id)).toEqual(["sid-2"]);
  });

  it("ignores a stranded gate the run has already moved past", () => {
    const overview = overviewOf({
      sessions: [attempt({ work_order_id: "wo-1", session_id: "sid-1", unit_id: "c1" })],
      gates: [gate({ id: "gate-1", unit_id: "c1", actionable: false })],
    });

    expect(overview.sessions_awaiting_action).toEqual([]);
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

    expect(overview.active_gates.map((entry) => entry.gate_id)).toEqual(["gate-open"]);
    expect(overview.active_gates[0].resume_actions).toEqual(["approve", "reject"]);
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
