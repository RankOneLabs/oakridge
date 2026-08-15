import { expect, test } from "bun:test";

import type { EpicWorkflowProfile, EpicWorkflowProfileId } from "../src/domain/epic";
import type { FinalPullRequestReconciliation, PullRequestObservation } from "../src/domain/final-pull-request";
import type { WorkflowRunId } from "../src/domain/primitives";
import { PostgresFinalPullRequestRepository } from "../src/storage/postgres-policy";
import type { SqlExecutor, TransactionalSqlExecutor } from "../src/storage/sql-executor";

class TransactionStubSql implements TransactionalSqlExecutor {
  readonly calls: { statement: string; parameters: readonly unknown[] }[] = [];
  constructor(private readonly results: readonly (readonly object[])[]) {}
  async query<Row extends object>(statement: string, parameters: readonly unknown[]): Promise<readonly Row[]> {
    this.calls.push({ statement, parameters });
    return (this.results[this.calls.length - 1] ?? []) as readonly Row[];
  }
  transaction<Value>(operation: (transaction: SqlExecutor) => Promise<Value>): Promise<Value> { return operation(this); }
}

const runId = "00000000-0000-4000-8000-000000000001" as WorkflowRunId;
const profileId = "00000000-0000-4000-8000-000000000002" as EpicWorkflowProfileId;
const repository = (key: string, state: EpicWorkflowProfile["repositories"][number]["final_merge_state"]) => ({
  repository_key: key,
  repository_path: `/repos/${key}`,
  base_branch: "main",
  epic_branch: "epic/dbos",
  forge_repository: { provider: "github" as const, owner: "RankOneLabs", name: key },
  final_pull_request: null,
  final_merge_state: state,
});
const profile = (policy: EpicWorkflowProfile["final_merge_policy"]): EpicWorkflowProfile => ({
  id: profileId,
  workflow_run_id: runId,
  title: "DBOS",
  slug: "dbos",
  lifecycle_state: "final_integration",
  final_merge_policy: policy,
  repositories: [repository("oakridge", policy === "guarded" ? "pending" : "awaiting_confirmation"), repository("kbbl", "merged")],
  created_at: "2026-08-15T00:00:00Z",
  updated_at: "2026-08-15T00:00:00Z",
});
const observation: PullRequestObservation = {
  provider: "github",
  owner: "RankOneLabs",
  name: "oakridge",
  number: 418,
  url: "https://github.com/RankOneLabs/oakridge/pull/418",
  head_branch: "epic/dbos",
  base_branch: "main",
  head_sha: "deadbeef",
  state: "merged",
  source: "webhook",
  observed_at: "2026-08-15T01:00:00Z",
  merged_at: "2026-08-15T00:59:00Z",
};
const completedStages = [
  { stage_key: "build", operator_role: "build", ended_at: "2026-08-15T00:30:00Z", outcome: { kind: "succeeded" } },
  { stage_key: "assessment", operator_role: "assessment", ended_at: "2026-08-15T00:45:00Z", outcome: { kind: "succeeded" } },
];

test("final PR observation locks domain state and atomically preserves sibling repository bindings", async () => {
  const sql = new TransactionStubSql([[profile("guarded")], [], completedStages, [{ epic_profile_id: profileId }], []]);
  const result = await new PostgresFinalPullRequestRepository(sql).observe({
    run_id: runId, repository_key: "oakridge", observation, updated_at: "2026-08-15T01:01:00Z",
  });

  expect(result.ok && result.value.outcome).toBe("completed");
  expect(result.ok && result.value.profile.lifecycle_state).toBe("completed");
  expect(sql.calls[0]?.statement).toContain("FOR UPDATE");
  expect(sql.calls[2]?.statement).toContain("jsonb_each(definition.definition->'graph'->'stages')");
  expect(sql.calls[3]?.statement).toContain("EXCLUDED.observed_at >");
  const persistedRepositories = sql.calls[4]?.parameters[2] as EpicWorkflowProfile["repositories"];
  expect(persistedRepositories).toEqual([
    expect.objectContaining({ repository_key: "oakridge", final_merge_state: "merged", final_pull_request: expect.objectContaining({ number: 418 }) }),
    repository("kbbl", "merged"),
  ]);
});

test("a storage race cannot let an older final PR observation overwrite newer state", async () => {
  const current = profile("guarded");
  const previous: FinalPullRequestReconciliation = {
    epic_profile_id: profileId, repository_key: "oakridge", observation: { ...observation, observed_at: "2026-08-15T00:30:00Z" },
    mismatch: null, merged_evidence_at: null, confirmation_idempotency_key: null, operator_comment: null,
    confirmed_at: null, updated_at: "2026-08-15T00:30:00Z",
  };
  const sql = new TransactionStubSql([[current], [previous], completedStages, []]);
  const result = await new PostgresFinalPullRequestRepository(sql).observe({
    run_id: runId, repository_key: "oakridge", observation, updated_at: "2026-08-15T01:01:00Z",
  });

  expect(result.ok && result.value.outcome).toBe("ignored_stale");
  expect(sql.calls.some((call) => call.statement.includes("UPDATE oakridge.epic_workflow_profile"))).toBe(false);
});

test("external confirmation records audit fields once and completes the profile transactionally", async () => {
  const current = profile("external_confirmation");
  const reconciliation: FinalPullRequestReconciliation = {
    epic_profile_id: profileId, repository_key: "oakridge", observation,
    mismatch: null, merged_evidence_at: observation.merged_at, confirmation_idempotency_key: null,
    operator_comment: null, confirmed_at: null, updated_at: observation.observed_at,
  };
  const sql = new TransactionStubSql([[current], [], [reconciliation], completedStages, [{ epic_profile_id: profileId }], []]);
  const result = await new PostgresFinalPullRequestRepository(sql).confirm({
    run_id: runId,
    repository_key: "oakridge",
    request: { idempotency_key: "confirm-418", operator_comment: "merged externally" },
    confirmed_at: "2026-08-15T01:05:00Z",
  });

  expect(result.ok && result.value.outcome).toBe("completed");
  expect(sql.calls[1]?.statement).toContain("confirmation_idempotency_key = $2 FOR UPDATE");
  expect(sql.calls[4]?.statement).toContain("operator_comment = CASE WHEN confirmation_idempotency_key IS NULL");
  expect(sql.calls[4]?.statement).toContain("confirmed_at = COALESCE");
  expect(sql.calls[5]?.parameters[1]).toBe("completed");
});

test("final integration eligibility comes only from current-attempt StageInstance outcomes", async () => {
  const sql = new TransactionStubSql([[profile("guarded")], [], [
    completedStages[0]!,
    { stage_key: "assessment", operator_role: "assessment", ended_at: null, outcome: null },
  ]]);
  const result = await new PostgresFinalPullRequestRepository(sql).observe({
    run_id: runId, repository_key: "oakridge", observation, updated_at: "2026-08-15T01:01:00Z",
  });

  expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: "not_eligible" }) });
  expect(sql.calls[2]?.statement).not.toContain("executor_projection");
  expect(sql.calls).toHaveLength(3);
});

test("confirmation idempotency keys cannot cross repository bindings in one Epic", async () => {
  const sql = new TransactionStubSql([[profile("external_confirmation")], [{ repository_key: "kbbl" }]]);
  const result = await new PostgresFinalPullRequestRepository(sql).confirm({
    run_id: runId, repository_key: "oakridge", request: { idempotency_key: "already-used" }, confirmed_at: "2026-08-15T01:05:00Z",
  });

  expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: "idempotency_conflict" }) });
  expect(sql.calls).toHaveLength(2);
});

test("confirmation replay returns the original durable audit without rewriting its comment", async () => {
  const current = profile("external_confirmation");
  const reconciliation: FinalPullRequestReconciliation = {
    epic_profile_id: profileId, repository_key: "oakridge", observation,
    mismatch: null, merged_evidence_at: observation.merged_at, confirmation_idempotency_key: "confirm-418",
    operator_comment: "original", confirmed_at: "2026-08-15T01:05:00Z", updated_at: "2026-08-15T01:05:00Z",
  };
  const sql = new TransactionStubSql([[current], [{ repository_key: "oakridge" }], [reconciliation]]);
  const result = await new PostgresFinalPullRequestRepository(sql).confirm({
    run_id: runId, repository_key: "oakridge",
    request: { idempotency_key: "confirm-418", operator_comment: "changed on retry" },
    confirmed_at: "2026-08-15T02:00:00Z",
  });

  expect(result).toEqual({ ok: true, value: { outcome: "already_completed", profile: current, reconciliation } });
  expect(sql.calls.some((call) => call.statement.startsWith("UPDATE"))).toBe(false);
});
