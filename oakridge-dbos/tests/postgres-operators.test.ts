import { expect, test } from "bun:test";
import type { SqlExecutor } from "../src/storage/sql-executor";
import { PostgresOperatorProjectionRepository } from "../src/storage/postgres-operators";
import type { WorkflowRunId } from "../src/domain/primitives";

test("pending gates are projected directly from published DBOS events", async () => {
  let sql = "";
  const executor: SqlExecutor = { query: async <Row>(statement: string) => { sql = statement; return [{ run_id: "run-1", stage_name: "build", stage_instance_id: "stage-1", unit_id: "web", artifact_revision_id: "artifact-1", gate_step: "artifact_approval", actions: ["approve", "request_revision"] }] as Row[]; } };
  const gates = await new PostgresOperatorProjectionRepository(executor).list_pending_gates();
  expect(sql).toContain("FROM dbos.workflow_events");
  expect(sql).toContain("COALESCE((event.value::jsonb)->'json', event.value::jsonb)");
  expect(sql).toContain("artifact.lifecycle_state = 'current'");
  expect(gates).toEqual([expect.objectContaining({ id: "stage-1:web", gate_step: "artifact_approval", resume_actions: ["approve", "request_revision"] })]);
});

test("run list derives parked state by joining root status with DBOS gate events", async () => {
  let params: readonly unknown[] = [];
  const executor: SqlExecutor = { query: async <Row>(_sql: string, values: readonly unknown[]) => { params = values; return [{ id: "run-1", workflow_name: "dev-flow", root_workflow_id: "root-2", dbos_status: "PENDING", current_stage: "build", parked_count: "2", updated_at_epoch_ms: "1786737600000", outcome: null, is_stuck: false, archived: false }] as Row[]; } };
  const runs = await new PostgresOperatorProjectionRepository(executor).list_runs("active");
  expect(params).toEqual([false, 3600]);
  expect(runs).toEqual([expect.objectContaining({ id: "run-1", current_attempt_root_workflow_id: "root-2", status: "parked", current_stage: "build", parked_count: 2, is_failed: false })]);
});

test("a run whose workflow returned a failure projects as failed, not complete", async () => {
  const executor: SqlExecutor = { query: async <Row>() => [{ id: "run-1", workflow_name: "dev-flow", root_workflow_id: "root-1", dbos_status: "SUCCESS", current_stage: null, parked_count: "0",
    updated_at_epoch_ms: "1786737600000", outcome: { kind: "failed", code: "required_output_missing", detail: "unit 'web' is missing: plan" }, is_stuck: false, archived: false }] as Row[] };
  const runs = await new PostgresOperatorProjectionRepository(executor).list_runs("active");
  expect(runs[0]).toEqual(expect.objectContaining({ status: "failed", is_failed: true }));
});

test("run list projects stuck state from the query rather than hardcoding false", async () => {
  const executor: SqlExecutor = { query: async <Row>() => [{ id: "run-1", workflow_name: "dev-flow", root_workflow_id: "root-1", dbos_status: "PENDING", current_stage: "build", parked_count: "0",
    updated_at_epoch_ms: "1786737600000", outcome: null, is_stuck: true, archived: false }] as Row[] };
  const runs = await new PostgresOperatorProjectionRepository(executor).list_runs("active");
  expect(runs[0]?.is_stuck).toBe(true);
});

test("stuck detection covers rerun waits, dead terminal observers, and stalled progress", async () => {
  let sql = "";
  const executor: SqlExecutor = { query: async <Row>(statement: string) => { sql = statement; return [] as Row[]; } };
  await new PostgresOperatorProjectionRepository(executor).list_runs("active");
  expect(sql).toContain("'stage-rerun-state'");
  expect(sql).toContain("|| ':terminal'");
  expect(sql).toContain("extract(epoch FROM now())");
});

test("the stall window is configurable and passed as a query parameter", async () => {
  let params: readonly unknown[] = [];
  const executor: SqlExecutor = { query: async <Row>(_sql: string, values: readonly unknown[]) => { params = values; return [] as Row[]; } };
  await new PostgresOperatorProjectionRepository(executor, { stall_threshold_seconds: 120 }).list_runs("all");
  expect(params).toEqual([null, 120]);
});

test("run archive is domain state and never mutates DBOS workflow status", async () => {
  let sql = "";
  const executor: SqlExecutor = { query: async <Row>(statement: string) => { sql = statement; return [{ id: "run-1" }] as Row[]; } };
  const updated = await new PostgresOperatorProjectionRepository(executor).set_run_archived("run-1" as WorkflowRunId, true);
  expect(updated).toBe(true);
  expect(sql).toContain("UPDATE oakridge.workflow_run");
  expect(sql).not.toContain("dbos.workflow_status");
});

test("application version inventory identifies old versions that still own gated runs", async () => {
  const executor: SqlExecutor = { query: async <Row>() => [{ application_version: "old-sha", run_count: "3", pending_run_count: "2", gated_run_count: "1", oldest_pending_epoch_ms: "1786737600000" }] as Row[] };
  const versions = await new PostgresOperatorProjectionRepository(executor).list_application_versions();
  expect(versions).toEqual([expect.objectContaining({ application_version: "old-sha", run_count: 3, pending_run_count: 2, gated_run_count: 1 })]);
});

test("run detail derives stages and units from DBOS child workflows", async () => {
  const statements: string[] = [];
  const executor: SqlExecutor = { query: async <Row>(sql: string) => {
    statements.push(sql);
    if (sql.includes("FROM oakridge.workflow_run run")) return [{ id: "run-1", workflow_name: "dev-flow", root_workflow_id: "root-2", dbos_status: "PENDING", current_stage: "build", parked_count: "1", updated_at_epoch_ms: "1786737600000", archived: false }] as Row[];
    if (sql.includes("FROM oakridge.stage_instance stage JOIN")) return [{ stage_instance_id: "stage-1", name: "build", stage_type: "delegated_session", operator_role: null, dbos_status: "PENDING", has_pending_gate: true }] as Row[];
    if (sql.includes("stage-admission-state") && sql.includes("stage.run_id = $1")) return [{ stage_instance_id: "stage-1", unit_id: "web", params: { title: "Web" }, external_reference: { kind: "kbbl_session", session_id: "session-1" }, dbos_status: "PENDING", has_pending_gate: true, admission_required: true, admitted: false, admission_eligible: true, admission_blocked_by: [] }] as Row[];
    if (sql.includes("FROM oakridge.epic_workflow_profile")) return [{ id: "epic-1", workflow_run_id: "run-1", title: "Epic", slug: "epic", lifecycle_state: "active", final_merge_policy: "guarded", repositories: [], created_at: "2026-08-14T00:00:00Z", updated_at: "2026-08-14T00:00:00Z" }] as Row[];
    if (sql.includes("FROM oakridge.workflow_attempt attempt")) return [{ root_workflow_id: "root-1", forked_from_root_workflow_id: null, dbos_status: "ERROR", created_at: "2026-08-14T00:00:00Z", parked_count: "0" }, { root_workflow_id: "root-2", forked_from_root_workflow_id: "root-1", dbos_status: "PENDING", created_at: "2026-08-14T01:00:00Z", parked_count: "1" }] as Row[];
    return [{ stage_instance_id: "stage-1", id: "artifact-1", type_id: "dev.build_result", version: 1, label: "web" }] as Row[];
  } };
  const detail = await new PostgresOperatorProjectionRepository(executor).get_run("run-1" as WorkflowRunId);
  expect(statements.filter((sql) => sql.includes("workflow_events")).every((sql) => sql.includes("->'json'"))).toBe(true);
  expect(detail).toEqual(expect.objectContaining({ current_attempt_root_workflow_id: "root-2", status: "parked",
    attempts: [expect.objectContaining({ root_workflow_id: "root-1", status: "failed" }), expect.objectContaining({ root_workflow_id: "root-2", forked_from_root_workflow_id: "root-1", status: "parked" })],
    epic_profile: expect.objectContaining({ id: "epic-1", lifecycle_state: "active" }), stages: [expect.objectContaining({ name: "build", status: "parked", delegated_kbbl_sid: "session-1", units: [expect.objectContaining({ unit_id: "web", status: "parked", admission_required: true, admitted: false, admission_eligible: true })] })] }));
});

test("review inbox maps pending DBOS gates to existing operator actions", async () => {
  const executor: SqlExecutor = { query: async <Row>(sql: string) => {
    if (sql.includes("handoff-state")) return [{ run_id: "run-1", workflow_name: "dev-flow", stage_instance_id: "stage-1", stage_name: "build", unit_id: "web", params: { repository_key: "web", title: "Web" }, dbos_status: "PENDING", artifact_revision_id: "artifact-1", handoff_status: "awaiting_downstream", admission_required: true, admitted: true, admission_eligible: true, admission_blocked_by: [], updated_at_epoch_ms: "1786737600000" }] as Row[];
    if (sql.includes("FROM dbos.workflow_events event") && !sql.includes("FROM oakridge.workflow_run run")) return [{ run_id: "run-1", stage_name: "build", stage_instance_id: "stage-1", unit_id: "web", artifact_revision_id: "artifact-1", gate_step: "artifact_approval", actions: ["approve", "request_revision"] }] as Row[];
    return [{ id: "run-1", workflow_name: "dev-flow", dbos_status: "PENDING", current_stage: "build", parked_count: "1", updated_at_epoch_ms: "1786737600000", archived: false }] as Row[];
  } };
  const inbox = await new PostgresOperatorProjectionRepository(executor).get_review_inbox();
  expect(inbox.items).toEqual([expect.objectContaining({ kind: "artifact_gate", state: "actionable", gate_id: "stage-1:web", artifact_revision_id: "artifact-1", repository_key: "web", title: "Web", resume_actions: ["approve", "request_revision"] })]);
  expect(inbox.cohorts).toEqual([expect.objectContaining({ id: "stage-1:web", lifecycle: "artifact_review", repository_key: "web", gate_id: "stage-1:web", artifact_url: "/artifact_details/artifact-1", admission: { required: true, admitted: true, eligible: true, blocked_by: [] }, completion: { build_complete: true, assessment_complete: false } })]);
});

test("cohort projection surfaces validated pull request mismatches as blocked inbox state", async () => {
  const reconciliation = { repository_key: "web", observation: { owner: "rol", name: "web", number: 7, url: "https://github.test/rol/web/pull/7", head_branch: "wrong", base_branch: "main", state: "open", observed_at: "2026-08-14T12:00:00Z" }, mismatch: { kind: "head_branch_mismatch", detail: "expected cohort branch" }, completed_at: null, updated_at: "2026-08-14T12:00:00Z" };
  const executor: SqlExecutor = { query: async <Row>(sql: string) => {
    if (sql.includes("handoff-state")) return [{ run_id: "run-1", workflow_name: "dev-flow", stage_instance_id: "stage-1", stage_name: "build", unit_id: "web", params: { repository_key: "web" }, dbos_status: "PENDING", artifact_revision_id: "artifact-1", handoff_status: "awaiting_external", reconciliation, admission_required: false, admitted: true, admission_eligible: true, admission_blocked_by: [], updated_at_epoch_ms: "1786737600000" }] as Row[];
    if (sql.includes("FROM dbos.workflow_events event") && !sql.includes("FROM oakridge.workflow_run run")) return [] as Row[];
    return [{ id: "run-1", workflow_name: "dev-flow", dbos_status: "PENDING", current_stage: "build", parked_count: "0", updated_at_epoch_ms: "1786737600000", archived: false }] as Row[];
  } };
  const inbox = await new PostgresOperatorProjectionRepository(executor).get_review_inbox();
  expect(inbox.cohorts).toEqual([expect.objectContaining({ lifecycle: "pull_request_mismatch", pr_url: "https://github.test/rol/web/pull/7", pull_request_reconciliation: reconciliation })]);
  expect(inbox.items).toEqual([expect.objectContaining({ kind: "pull_request_mismatch", state: "blocked", unit_id: "web" })]);
});
