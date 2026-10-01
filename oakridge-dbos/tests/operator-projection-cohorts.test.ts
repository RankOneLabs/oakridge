import { expect, test } from "bun:test";

import { selectPullRequestMergeWaits, type OperatorCohortSummary } from "../src/domain/operator-projections";
import type { CohortId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";

const waiting = (overrides: Partial<OperatorCohortSummary> = {}): OperatorCohortSummary => ({
  id: "30000000-0000-0000-0000-000000000001",
  run_id: "10000000-0000-0000-0000-000000000001" as WorkflowRunId,
  workflow_name: "dev flow", stage_instance_id: "20000000-0000-0000-0000-000000000001" as StageInstanceId,
  stage_name: "build", unit_id: "api" as UnitId, repository_key: "oakridge", title: "Build API",
  lifecycle: "blocked", blocked_reason: "external", next_actor: "external",
  completion: { build_complete: true, assessment_complete: true }, blocked_by: [],
  artifact_revision_id: null, artifact_url: null, gate_id: null, gate_url: null,
  pr_url: "https://example.test/pr/1", pull_request_reconciliation: null, updated_at: "2026-09-29T00:00:00Z",
  ...overrides,
});

test("only cohorts actually awaiting a pull request merge become merge waits", () => {
  const selected = selectPullRequestMergeWaits([
    waiting(), waiting({ id: "active", lifecycle: "active" }),
    waiting({ id: "operator", next_actor: "operator" }), waiting({ id: "missing-pr", pr_url: null }),
    waiting({ id: "retry", blocked_reason: "retry" }),
  ]);
  expect(selected).toEqual([{
    cohort_id: "30000000-0000-0000-0000-000000000001" as CohortId,
    stage_instance_id: "20000000-0000-0000-0000-000000000001" as StageInstanceId,
    unit_id: "api" as UnitId, pull_request_url: "https://example.test/pr/1",
  }]);
});
