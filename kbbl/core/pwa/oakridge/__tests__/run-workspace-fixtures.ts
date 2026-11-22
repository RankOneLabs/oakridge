// Run, session and gate fixtures for the run workspace wiring tests.
import type { ParkedGate } from "../artifact-types";
import type { RunDetail, RunSessionAttempt } from "../run-types";

export const RUN: RunDetail = {
  id: "run-1",
  title: "Ship the run command center",
  repository_keys: ["oakridge"],
  workflow_name: "dev_flow_v2",
  status: "parked",
  is_stuck: false,
  parked_count: 2,
  updated_at: "2026-09-01T10:00:00Z",
  stages: [
    {
      stage_instance_id: "si-plan",
      name: "plan",
      type: "delegated_session",
      status: "complete",
      artifacts: [{ id: "art-plan", type_id: "planning.plan", version: 1, created_at: "2026-09-01T08:00:00Z" }],
      delegated_kbbl_sid: "sid-plan",
      worktree: null,
    },
    {
      stage_instance_id: "si-build",
      name: "build",
      type: "delegated_session",
      status: "running",
      artifacts: [{ id: "art-build", type_id: "cohort.build_result", version: 1, created_at: "2026-09-01T09:00:00Z" }],
      delegated_kbbl_sid: null,
      worktree: null,
      units: [{ unit_id: "c1", sid: "sid-c1", worktree: null, status: "running", gate: null, is_retryable: false }],
    },
  ],
};

export const SESSIONS: RunSessionAttempt[] = [
  // Only the attempt list knows this one: a unit's `sid` on the run is its
  // current attempt, so a superseded attempt's transcript is reachable from
  // nowhere else. It is the case that tells whether the list was read at all.
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
    work_order_state: "started",
    created_at: "2026-09-01T09:00:00Z",
    completed_at: null,
    executor_health_kind: null,
    cleanup_state: "pending",
  },
];

export const GATES: ParkedGate[] = [
  {
    id: "gate-1",
    gate_type: "artifact_review",
    gate_step: null,
    run_id: "run-1",
    stage_name: "build",
    unit_id: "c1",
    artifact_revision_id: "rev-1",
    worktree: null,
    resume_actions: ["approve", "reject"],
    offered_decisions: ["approve", "reject"],
    run_state: "active",
    actionable: true,
  },
];
