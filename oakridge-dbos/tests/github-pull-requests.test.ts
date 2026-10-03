import { expect, test } from "bun:test";

import type { OperatorCohortLifecycle, OperatorCohortSummary } from "../src/domain/operator-projections";
import type { StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { GithubPullRequestReader, pollStagePullRequests, selectCohortsAwaitingReview } from "../src/runtime/github-pull-requests";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";

const cohort = (unitId: string, lifecycle: OperatorCohortLifecycle): OperatorCohortSummary => ({
  id: `stage:${unitId}`, run_id: "00000000-0000-4000-8000-000000000001" as WorkflowRunId, workflow_name: "dev flow",
  stage_instance_id: "00000000-0000-4000-8000-000000000002" as StageInstanceId, stage_name: "build", unit_id: unitId as UnitId,
  repository_key: "oakridge", title: unitId, lifecycle,
  blocked_reason: lifecycle === "blocked" ? "external" : null,
  next_actor: lifecycle === "blocked" ? "external" : null,
  completion: { build_complete: true, assessment_complete: false },
  blocked_by: [],
  artifact_revision_id: null, artifact_url: null, gate_id: null, gate_url: null, links: [], facts: [],
  updated_at: "2026-08-18T12:00:00.000Z",
});

test("only cohorts parked on their pull request are polled", () => {
  const selected = selectCohortsAwaitingReview([
    cohort("foundation", "blocked"), cohort("web", "active"),
    cohort("api", "pending"), cohort("cli", "complete"),
    { ...cohort("operator", "blocked"), next_actor: "operator" },
  ]);
  expect(selected.map((candidate) => String(candidate.unit_id))).toEqual(["foundation"]);
});

const githubPayload = (overrides: Record<string, unknown> = {}) => ({
  number: 440, html_url: "https://github.com/RankOneLabs/oakridge/pull/440",
  state: "open", merged: false, merged_at: null,
  head: { ref: "cohort/foundation", sha: "abc123" }, base: { ref: "epic/tiers" },
  ...overrides,
});

const readerReturning = (status: number, payload: unknown) => {
  const calls: string[] = [];
  const http = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { reader: new GithubPullRequestReader({ token: "test-token" }, http), calls };
};

test("the poller delegates merge verification to canonical cohort ingress", async () => {
  let calls = 0;
  const sql = { async query(statement: string) { return statement.includes("AS cohort_id")
    ? [{ cohort_id: "cohort", state: "awaiting_merge" }] : [{ state: "complete" }]; } } as unknown as TransactionalSqlExecutor;
  const stage_events = { async advance() { calls++; return { ok: true as const, value: { commits: 1, reason: "complete" } }; } };
  expect(await pollStagePullRequests({ sql, stage_events })).toEqual([{ cohort_id: "cohort" as never, state: "complete", kind: "observed" }]);
  expect(calls).toBe(1);
});

test("an open pull request reads as open", async () => {
  const { reader, calls } = readerReturning(200, githubPayload());
  const read = await reader.read("RankOneLabs", "oakridge", 440);
  const observation = read.ok ? read.value : null;
  expect(observation?.state).toBe("open");
  expect(observation?.source).toBe("poll");
  expect(observation?.head_branch).toBe("cohort/foundation");
  expect(observation?.base_branch).toBe("epic/tiers");
  expect(calls[0]).toBe("https://api.github.com/repos/RankOneLabs/oakridge/pulls/440");
});

/**
 * GitHub reports a merged pull request as `state: "closed"`. Reading the state
 * alone would file every successful merge as a close without merge, which is a
 * mismatch — so the run would refuse the very evidence it is waiting for.
 */
test("a merged pull request reads as merged even though GitHub calls it closed", async () => {
  const { reader } = readerReturning(200, githubPayload({ state: "closed", merged: true, merged_at: "2026-08-18T11:00:00Z" }));
  const read = await reader.read("RankOneLabs", "oakridge", 440);
  const observation = read.ok ? read.value : null;
  expect(observation?.state).toBe("merged");
  expect(observation?.merged_at).toBe("2026-08-18T11:00:00Z");
});

test("a pull request closed without merging reads as closed_unmerged", async () => {
  const { reader } = readerReturning(200, githubPayload({ state: "closed", merged: false, merged_at: null }));
  const read = await reader.read("RankOneLabs", "oakridge", 440);
  const observation = read.ok ? read.value : null;
  expect(observation?.state).toBe("closed_unmerged");
});

/**
 * A repository the token cannot see is not evidence of anything. Returning
 * nothing leaves the cohort waiting for the operator, which is the fallback.
 */
test("a pull request that cannot be read yields no observation", async () => {
  const { reader } = readerReturning(404, { message: "Not Found" });
  expect(await reader.read("RankOneLabs", "oakridge", 440)).toEqual({ ok: true, value: null });
});

test("a payload missing the fields an observation needs yields no observation", async () => {
  const { reader } = readerReturning(200, githubPayload({ head: null }));
  expect((await reader.read("RankOneLabs", "oakridge", 440)).ok).toBe(false);
});

test("a GitHub 503 is distinguishable from a missing pull request", async () => {
  const { reader } = readerReturning(503, { message: "Unavailable" });
  expect(await reader.read("RankOneLabs", "oakridge", 440)).toEqual({ ok: false, error: {
    kind: "unavailable", status: 503, detail: "GitHub pull request read failed (503)",
  } });
});
