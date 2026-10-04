import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareV15StageFixture } from "./support/v15-stage-fixture";
import { discoverFinalIntegrationPullRequest, prepareFinalIntegrationWorktree, verifyFinalIntegrationPullRequest } from "../src/runtime/final-integration";
import { GithubPullRequestReader } from "../src/runtime/github-pull-requests";
import type { CohortId } from "../src/domain/primitives";
import type { FinalIntegrationInputs } from "../src/domain/dev-flow-v15";
import type { PrSummaryBody } from "../src/domain/dev-flow-artifacts";

const prepare = async () => {
  const fixture = await prepareV15StageFixture();
  const cohort_id = randomUUID() as CohortId;
  const context = { ...fixture.context, repositories: fixture.context.repositories.map((repository) => ({ ...repository,
    forge_repository: { provider: "github", owner: "example", name: "oakridge" } })) };
  await fixture.sql.query("UPDATE oakridge.workflow_run SET context=$2::jsonb WHERE id=$1", [fixture.run_id, JSON.stringify(context)]);
  await fixture.sql.query("UPDATE oakridge.stage_instance SET stage_key='final_integration',stage_contract=$2::jsonb WHERE id=$1",
    [fixture.stage_id, JSON.stringify(fixture.definition.stages.final_integration)]);
  const before = await fixture.runGit(fixture.repository, ["rev-parse", "HEAD"]);
  await fixture.runGit(fixture.repository, ["-c", "user.name=B4", "-c", "user.email=b4@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "merged implementations"]);
  const head = await fixture.runGit(fixture.repository, ["rev-parse", "HEAD"]);
  await fixture.runGit(fixture.repository, ["push", "origin", "HEAD:refs/heads/epic/b4"]);
  const inputs: FinalIntegrationInputs = { repository: { repository_key: "oakridge" as never, repository_path: fixture.repository,
    integration_branch: "main", base_branch: "epic/b4", base_head_sha: before as never }, completed_cohorts: [] };
  await fixture.sql.query(`INSERT INTO oakridge.cohort (id,run_id,stage_instance_id,cohort_key,state,status,frozen_inputs)
    VALUES ($1,$2,$3,'oakridge','working','active',$4::jsonb)`, [cohort_id, fixture.run_id, fixture.stage_id, JSON.stringify(inputs)]);
  const forge = { head_sha: head, head_branch: "epic/b4", base_branch: "main", state: "open", merged: false, candidates: [1] };
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/repos/example/oakridge/pulls") return Response.json(forge.candidates.map((number) => ({ number })));
    const number = Number(path.split("/").at(-1));
    return Response.json({ number, html_url: `https://github.com/example/oakridge/pull/${number}`, state: forge.state,
      merged: forge.merged, merged_at: null, head: { sha: forge.head_sha, ref: forge.head_branch }, base: { ref: forge.base_branch } });
  } });
  const reader = new GithubPullRequestReader({ token: "fixture", api_base_url: `http://127.0.0.1:${server.port}` });
  const summary: PrSummaryBody = { repository_key: "oakridge", branch: "epic/b4", base_branch: "main",
    pr_url: "https://github.com/example/oakridge/pull/1", summary: "complete", review_status: null };
  return { ...fixture, cohort_id, forge, summary, head, dependencies: { sql: fixture.sql, git: fixture.git, reader },
    close: async () => { server.stop(true); await fixture.close(); } };
};

test("final integration worktree starts at the pushed run head without changing the project checkout", async () => {
  const fixture = await prepare();
  try {
    const checkout = await fixture.runGit(fixture.repository, ["rev-parse", "HEAD"]);
    expect((await prepareFinalIntegrationWorktree(fixture.dependencies, fixture.cohort_id)).ok).toBe(true);
    const worktree = join(fixture.repository, ".worktrees", "oakridge", fixture.stage_id, "oakridge");
    expect(await fixture.runGit(worktree, ["rev-parse", "HEAD"])).toBe(fixture.head);
    expect(await fixture.runGit(fixture.repository, ["rev-parse", "HEAD"])).toBe(checkout);
    expect((await readFile(join(worktree, ".git"), "utf8")).startsWith("gitdir:")).toBe(true);
    expect((await prepareFinalIntegrationWorktree(fixture.dependencies, fixture.cohort_id)).ok).toBe(true);
  } finally { await fixture.close(); }
});

test("final PR verification checks frozen repository branches and the exact pushed head", async () => {
  const fixture = await prepare();
  try {
    expect((await verifyFinalIntegrationPullRequest(fixture.dependencies, { cohort_id: fixture.cohort_id, summary: fixture.summary })).ok).toBe(true);
    for (const summary of [{ ...fixture.summary, repository_key: "other" }, { ...fixture.summary, branch: "other" },
      { ...fixture.summary, base_branch: "other" }, { ...fixture.summary, pr_url: "https://github.com/other/repo/pull/1" }]) {
      expect((await verifyFinalIntegrationPullRequest(fixture.dependencies, { cohort_id: fixture.cohort_id, summary })).ok).toBe(false);
    }
    fixture.forge.head_sha = "different";
    expect((await verifyFinalIntegrationPullRequest(fixture.dependencies, { cohort_id: fixture.cohort_id, summary: fixture.summary })).ok).toBe(false);
  } finally { await fixture.close(); }
});

test("retry discovers and reuses a matching final PR even if its publication was lost", async () => {
  const fixture = await prepare();
  try {
    const found = await discoverFinalIntegrationPullRequest(fixture.dependencies, fixture.cohort_id);
    expect(found.ok && found.value?.pr_url).toBe(fixture.summary.pr_url);
    fixture.forge.state = "closed";
    fixture.forge.merged = true;
    const merged = await discoverFinalIntegrationPullRequest(fixture.dependencies, fixture.cohort_id);
    expect(merged.ok && merged.value?.state).toBe("merged");
    fixture.forge.candidates = [1, 2];
    expect((await discoverFinalIntegrationPullRequest(fixture.dependencies, fixture.cohort_id)).ok).toBe(false);
    expect(await fixture.sql.query("SELECT id FROM oakridge.session", [])).toEqual([]);
  } finally { await fixture.close(); }
});
