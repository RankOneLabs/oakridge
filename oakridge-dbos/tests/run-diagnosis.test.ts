import { expect, test } from "bun:test";
import { createDevFlowAdapterRegistry } from "../src/adapters/dev-flow";
import { PostgresOperatorProjectionRepository } from "../src/storage/postgres-operators";
import { materializeStageInStorage } from "../src/storage/materialize-stage";
import { prepareV15StageFixture } from "./support/v15-stage-fixture";
import type { WorkflowRunId } from "../src/domain/primitives";

test("diagnosis projects canonical pending stages and session-free provision ownership", async () => {
  const fixture = await prepareV15StageFixture();
  try {
    const opened = await materializeStageInStorage(fixture.sql, { stage_instance_id: fixture.stage_id, at: new Date().toISOString() });
    if (!opened.ok) throw new Error(opened.error.detail);
    const projections = new PostgresOperatorProjectionRepository(fixture.sql, "shadow", createDevFlowAdapterRegistry());
    const diagnosis = await projections.get_run_diagnosis(fixture.run_id as WorkflowRunId);
    expect(diagnosis?.run.stages.map((stage) => stage.name)).toEqual([
      "repository_preparation", "spec_analysis", "planning", "brief_writing", "implementation", "final_integration",
    ]);
    expect(diagnosis?.run.stages[0]?.units[0]?.workers.map((worker) => worker.worker)).toEqual(["provision"]);
    expect(diagnosis?.sessions).toEqual([]);
    expect(diagnosis?.stage_progress).toEqual({ total: 6, pending: 5, active: 1, blocked: 0, complete: 0, failed: 0, cancelled: 0 });
  } finally { await fixture.close(); }
}, 30_000);

test("an interrupted operation is actionable without a session or legacy gate", async () => {
  const fixture = await prepareV15StageFixture();
  try {
    const opened = await materializeStageInStorage(fixture.sql, { stage_instance_id: fixture.stage_id, at: new Date().toISOString() });
    if (!opened.ok || opened.value.kind !== "opened") throw new Error("stage did not materialize");
    await fixture.sql.query("UPDATE oakridge.cohort_worker SET state='interrupted',interrupted=$2::jsonb WHERE cohort_id=$1", [opened.value.cohort_ids[0],
      JSON.stringify({ code: "operation_interrupted", detail: "executor stopped", execution_id: null })]);
    const projections = new PostgresOperatorProjectionRepository(fixture.sql, "shadow", createDevFlowAdapterRegistry());
    expect((await projections.list_runs())[0]?.attention_count).toBe(1);
    const diagnosis = await projections.get_run_diagnosis(fixture.run_id as WorkflowRunId);
    expect(diagnosis?.run.stages[0]?.units[0]?.retryable).toBe(true);
    const inbox = await projections.get_review_inbox();
    expect(inbox.items.map((item) => ({ kind: item.kind, state: item.state }))).toEqual([{ kind: "cohort_retry", state: "actionable" }]);
  } finally { await fixture.close(); }
}, 30_000);
