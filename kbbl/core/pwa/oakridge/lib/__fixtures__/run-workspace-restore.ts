import type { ArtifactId, Sid } from "../../../lib/ids";
import type { RunDetail, RunSessionAttempt } from "../../run-types";
import type { RunSessionsRead } from "../run-sessions";
import type { RunWorkspacePane } from "../run-workspace";
import { resolveWorkspaceState } from "../run-workspace-restore";

export const sessionPane = (id: string): RunWorkspacePane => ({ kind: "session", session_id: id as Sid });
export const artifactPane = (id: string): RunWorkspacePane => ({ kind: "artifact", artifact_id: id as ArtifactId });

export const RUN: RunDetail = {
  id: "run-1",
  title: "Ship the run command center",
  repository_keys: ["oakridge"],
  workflow_name: "dev_flow_v2",
  status: "running",
  is_stuck: false,
  parked_count: 0,
  updated_at: "2026-09-01T10:00:00Z",
  stages: [
    {
      stage_instance_id: "si-plan",
      name: "plan",
      type: "delegated_session",
      status: "complete",
      artifacts: [{ id: "art-plan", type_id: "dev.plan", version: 1 }],
      delegated_kbbl_sid: "sid-plan",
      worktree: null,
    },
    {
      stage_instance_id: "si-build",
      name: "build",
      type: "delegated_session",
      status: "running",
      artifacts: [{ id: "art-build", type_id: "dev.build_result", version: 1 }],
      delegated_kbbl_sid: null,
      worktree: null,
      units: [
        { unit_id: "c1", sid: "sid-c1", worktree: null, status: "complete", gate: null, is_retryable: false },
        { unit_id: "c2", sid: "sid-c2", worktree: null, status: "running", gate: null, is_retryable: false },
      ],
    },
  ],
};

/**
 * `sid-c1-prior` is the one session only the attempt list knows about.
 *
 * A unit's `sid` on the run is its *current* attempt, so every other session id
 * here is reachable from the run read alone — which makes them useless for
 * telling whether the attempt list was consulted at all. A superseded attempt's
 * transcript exists only in this list, and a pane holding one is exactly what a
 * failed read must not quietly discard.
 */
export const SESSIONS: readonly RunSessionAttempt[] = [
  {
    work_order_id: "wo-0",
    session_id: "sid-c1-prior",
    stage_instance_id: "si-build",
    stage_key: "build",
    unit_id: "c1",
    reason: "initial",
    work_order_state: "abandoned",
    created_at: "2026-09-01T08:00:00Z",
    completed_at: "2026-09-01T08:20:00Z",
    executor_health_kind: null,
    cleanup_state: "complete",
  },
  {
    work_order_id: "wo-1",
    session_id: "sid-c1",
    stage_instance_id: "si-build",
    stage_key: "build",
    unit_id: "c1",
    reason: "initial",
    work_order_state: "completed",
    created_at: "2026-09-01T09:00:00Z",
    completed_at: "2026-09-01T09:30:00Z",
    executor_health_kind: null,
    cleanup_state: "complete",
  },
  {
    work_order_id: "wo-2",
    session_id: "sid-c2",
    stage_instance_id: "si-build",
    stage_key: "build",
    unit_id: "c2",
    reason: "initial",
    work_order_state: "started",
    created_at: "2026-09-01T09:40:00Z",
    completed_at: null,
    executor_health_kind: null,
    cleanup_state: "pending",
  },
];

export const resolve = (
  routePane: Parameters<typeof resolveWorkspaceState>[0]["routePane"],
  storedState: Parameters<typeof resolveWorkspaceState>[0]["storedState"],
) => resolveWorkspaceState({ routePane, storedState, run: RUN, sessions: LOADED_SESSIONS, purgedSessionIds: NO_PURGED_SESSIONS });

/** Nothing purged — the ordinary case, named so each call site says so. */
export const NO_PURGED_SESSIONS: ReadonlySet<string> = new Set();

/** The attempt read having landed — the ordinary case for every test but its own. */
export const LOADED_SESSIONS: RunSessionsRead = { kind: "loaded", attempts: SESSIONS };

