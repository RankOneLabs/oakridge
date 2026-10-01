import { describe, expect, test } from "bun:test";

import type { CoreStatus } from "../src/domain/records";
import { selectCohortRetryability } from "../src/domain/cohort-retry";
import { createDevFlowAdapterRegistry } from "../src/adapters/dev-flow";
import { PostgresOperatorProjectionRepository } from "../src/storage/postgres-operators";

import { RUN_ID, DiagnosisSql, diagnosisOf, stage, type ArtifactRow, type UnitRow } from "./support/operator-sql-stub";

describe("get_run_diagnosis", () => {
  test("run summary counts a retry-only cohort as operator attention", async () => {
    const build = stage(1, "blocked");
    const repository = new PostgresOperatorProjectionRepository(new DiagnosisSql({ stages: [build], units: [{
      cohort_id: "30000000-0000-0000-0000-000000000001", stage_instance_id: build.stage_instance_id,
      unit_id: "lost", params: null, status: "blocked", blocked_reason: "retry", next_actor: "operator",
      session_id: null, gate_step: null,
    }] }), "test-app-version", createDevFlowAdapterRegistry());
    expect((await repository.list_runs())[0]?.attention_count).toBe(1);
  });

  test("unit.retryable mirrors selectCohortRetryability", async () => {
    const build = stage(1, "blocked");
    const units: UnitRow[] = [
      { cohort_id: "30000000-0000-0000-0000-000000000001", stage_instance_id: build.stage_instance_id,
        unit_id: "lost", params: null, status: "blocked", blocked_reason: "retry", next_actor: "operator", session_id: null, gate_step: null },
      { cohort_id: "30000000-0000-0000-0000-000000000002", stage_instance_id: build.stage_instance_id,
        unit_id: "gated", params: null, status: "blocked", blocked_reason: "gate", next_actor: "operator", session_id: null, gate_step: "review" },
    ];
    const diagnosis = await diagnosisOf({ stages: [build], units });
    expect(diagnosis?.run.stages[0]?.units.map((unit) => unit.retryable))
      .toEqual(units.map((unit) => selectCohortRetryability(unit).kind === "retryable"));
  });
  test("attempt_count counts attempts whose session never bound", async () => {
    const diagnosis = await diagnosisOf({ stages: [stage(1, "active")], sessions: [
      { session_id: "sid-first", stage_key: "stage-1", cohort_id: "30000000-0000-0000-0000-000000000001",
        cohort_key: "api", attempt_number: 1, attempt_count: 2, status: "complete", created_at: "2026-09-29T01:00:00Z" },
    ] });
    expect(diagnosis?.sessions[0]?.attempt_count).toBe(2);
  });

  test("the latest-attempt predicate follows the cohort's latest attempt", async () => {
    const blocked = stage(1, "blocked");
    const cohortId = "30000000-0000-0000-0000-000000000001";
    const diagnosis = await diagnosisOf({ stages: [blocked], units: [{ cohort_id: cohortId,
      stage_instance_id: blocked.stage_instance_id, unit_id: "api", params: null, status: "blocked",
      blocked_reason: "gate", next_actor: "operator", session_id: "sid-first", gate_step: "review" }],
      sessions: [{ session_id: "sid-first", stage_key: blocked.name, cohort_id: cohortId, cohort_key: "api",
        attempt_number: 1, attempt_count: 2, status: "blocked", created_at: "2026-09-29T01:00:00Z" }] });
    expect(diagnosis?.sessions_awaiting_action).toEqual([]);
  });

  test("sessions carry cohort_key", async () => {
    const diagnosis = await diagnosisOf({ sessions: [{ session_id: "sid-api", stage_key: "build",
      cohort_id: "30000000-0000-0000-0000-000000000001", cohort_key: "api", attempt_number: 1,
      attempt_count: 1, status: "active", created_at: "2026-09-29T01:00:00Z" }] });
    expect(diagnosis?.sessions[0]?.cohort_key).toBe("api");
  });
  test("current_session picks the newest executing attempt and never a superseded one", async () => {
    const build = stage(1, "active");
    const diagnosis = await diagnosisOf({ stages: [build], sessions: [
      { session_id: "sid-superseded", stage_key: "stage-1", cohort_id: "30000000-0000-0000-0000-000000000001", attempt_number: 1, attempt_count: 2, status: "complete", created_at: "2026-09-29T01:00:00Z" },
      { session_id: "sid-executing-older", stage_key: "stage-1", cohort_id: "30000000-0000-0000-0000-000000000002", attempt_number: 1, attempt_count: 1, status: "active", created_at: "2026-09-29T02:00:00Z" },
      { session_id: "sid-executing-newest", stage_key: "stage-1", cohort_id: "30000000-0000-0000-0000-000000000001", attempt_number: 2, attempt_count: 2, status: "active", created_at: "2026-09-29T03:00:00Z" },
    ] });

    expect(diagnosis?.current_session?.session_id).toBe("sid-executing-newest");
  });

  test("sessions_awaiting_action names only the current attempt of an operator-blocked cohort", async () => {
    const blocked = stage(1, "blocked");
    const agentBlocked = { ...stage(2, "blocked"), next_actor: "agent" as const };
    const operatorCohort = "30000000-0000-0000-0000-000000000001";
    const agentCohort = "30000000-0000-0000-0000-000000000002";
    const units: UnitRow[] = [
      { cohort_id: operatorCohort, stage_instance_id: blocked.stage_instance_id, unit_id: "operator", params: null, status: "blocked", blocked_reason: "gate", next_actor: "operator", session_id: "sid-current", gate_step: "review" },
      { cohort_id: agentCohort, stage_instance_id: agentBlocked.stage_instance_id, unit_id: "agent", params: null, status: "blocked", blocked_reason: "gate", next_actor: "agent", session_id: "sid-agent", gate_step: null },
    ];
    const diagnosis = await diagnosisOf({ stages: [blocked, agentBlocked], units, sessions: [
      { session_id: "sid-old", stage_key: blocked.name, cohort_id: operatorCohort, attempt_number: 1, attempt_count: 2, status: "complete", created_at: "2026-09-29T01:00:00Z" },
      { session_id: "sid-current", stage_key: blocked.name, cohort_id: operatorCohort, attempt_number: 2, attempt_count: 2, status: "blocked", created_at: "2026-09-29T02:00:00Z" },
      { session_id: "sid-agent", stage_key: agentBlocked.name, cohort_id: agentCohort, attempt_number: 1, attempt_count: 1, status: "blocked", created_at: "2026-09-29T03:00:00Z" },
    ] });

    expect(diagnosis?.sessions_awaiting_action.map(({ session_id }) => session_id)).toEqual(["sid-current"]);
  });

  test("recent_artifacts orders by instant across stages and caps at eight", async () => {
    const stages = [stage(1, "complete"), stage(2, "active")];
    const artifacts: ArtifactRow[] = Array.from({ length: 10 }, (_, index) => ({
      stage_instance_id: stages[index % 2]!.stage_instance_id,
      id: `40000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
      type_id: "dev.result",
      version: index + 1,
      label: null,
      created_at: index === 8 ? "2026-11-01T01:30:00-04:00" : index === 9 ? "2026-11-01T01:15:00-05:00" : `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    const diagnosis = await diagnosisOf({ stages, artifacts });

    expect(diagnosis?.recent_artifacts).toHaveLength(8);
    expect(diagnosis?.recent_artifacts.slice(0, 2).map(({ revision }) => revision)).toEqual([10, 9]);
    expect(diagnosis?.recent_artifacts.at(-1)?.revision).toBe(3);
  });

  test("stage_progress counts every CoreStatus", async () => {
    const statuses: CoreStatus[] = ["pending", "active", "blocked", "complete", "failed", "cancelled"];
    const diagnosis = await diagnosisOf({ stages: statuses.map((status, index) => stage(index + 1, status)) });

    expect(diagnosis?.stage_progress).toEqual({ total: 6, pending: 1, active: 1, blocked: 1, complete: 1, failed: 1, cancelled: 1 });
  });

  test("stage_progress reports zero for an empty run", async () => {
    const diagnosis = await diagnosisOf({ stages: [] });

    expect(diagnosis?.stage_progress).toEqual({ total: 0, pending: 0, active: 0, blocked: 0, complete: 0, failed: 0, cancelled: 0 });
  });

  test("open gates remain visible when their run no longer allows a decision", async () => {
    const ended = stage(1, "cancelled");
    const diagnosis = await diagnosisOf({ stages: [ended], gates: [{
      wait_id: "gate-stranded", run_id: RUN_ID, stage_name: ended.name,
      stage_instance_id: ended.stage_instance_id, unit_id: "unit-1", artifact_revision_id: null,
      gate_step: "artifact_review", actions: ["approve"], repository_key: null, run_state: "cancelled",
    }] });

    expect(diagnosis?.active_gates).toEqual([expect.objectContaining({ id: "gate-stranded", actionable: false })]);
  });

  test("inbox items carry their gate's stage instance id", async () => {
    const build = stage(1, "blocked");
    const repository = new PostgresOperatorProjectionRepository(new DiagnosisSql({ stages: [build], gates: [{
      wait_id: "gate-1", run_id: RUN_ID, stage_name: build.name, stage_instance_id: build.stage_instance_id,
      unit_id: "api", artifact_revision_id: null, gate_step: "final_integration_review",
      actions: ["approve"], repository_key: null, run_state: "blocked",
    }] }), "test-app-version", createDevFlowAdapterRegistry());
    const inbox = await repository.get_review_inbox();
    expect(String(inbox.items[0]?.stage_instance_id)).toBe(build.stage_instance_id);
  });
});
