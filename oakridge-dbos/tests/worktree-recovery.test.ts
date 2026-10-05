import { expect, test } from "bun:test";
import { RepositoryPreparationOperation } from "../src/effects/operations/repository-preparation";
import { PullRequestObservationOperation } from "../src/effects/operations/pull-request-observation";
import type { GitCommandRunner } from "../src/domain/repository-provisioning";
import { GithubPullRequestReader } from "../src/runtime/github-pull-requests";

test("a lost worktree yields explicit recovery evidence", async () => {
  const git: GitCommandRunner = { run: async () => ({ exit_code: 128, stdout: "", stderr: "not a git repository" }) };
  expect(await new RepositoryPreparationOperation(git).execute({ repository_path: "/lost", expected_head: null }))
    .toEqual({ kind: "permanently_rejected", code: "worktree_unrecoverable", detail: "repository at /lost cannot be inspected: not a git repository" });
});

test("repository preparation pins the selected head", async () => {
  const git: GitCommandRunner = { run: async (_path, args) => ({ exit_code: 0, stdout: args[1] === "HEAD" ? "new-sha\n" : "/repo\n", stderr: "" }) };
  expect(await new RepositoryPreparationOperation(git).execute({ repository_path: "/repo", expected_head: "selected-sha" }))
    .toMatchObject({ kind: "permanently_rejected", code: "head_changed" });
});

for (const status of [401, 403, 404, 422, 503]) {
test(`PR discovery HTTP ${status} remains retryable IO`, async () => {
  const http = (async () => new Response("unavailable", { status })) as unknown as typeof fetch;
  const reader = new GithubPullRequestReader({ token: "test" }, http);
  const result = await new PullRequestObservationOperation(reader).execute({ query: { owner: "owner", name: "repo", head_branch: "head", base_branch: "base" } });
  expect(result.kind).toBe("transiently_unavailable");
});
}
