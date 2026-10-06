import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { RepositoryPreparationOperation } from "../src/effects/operations/repository-preparation";
import { PullRequestObservationOperation } from "../src/effects/operations/pull-request-observation";
import type { GitCommandRunner } from "../src/domain/repository-provisioning";
import { GithubPullRequestReader } from "../src/runtime/github-pull-requests";
import { BunGitCommandRunner } from "../src/runtime/git-command-runner";
import { bounded } from "../src/effects/outcomes";

test("a lost worktree yields explicit recovery evidence", async () => {
  const git: GitCommandRunner = { run: async () => ({ exit_code: 128, stdout: "", stderr: "not a git repository" }) };
  expect(await new RepositoryPreparationOperation(git).execute({ repository_path: "/lost", expected_head: null }))
    .toEqual({ kind: "permanently_rejected", code: "worktree_unrecoverable", detail: "repository at /lost cannot be inspected: not a git repository" });
});

test("repository preparation keys its result by the selected path, not the canonical toplevel", async () => {
  const git: GitCommandRunner = { run: async (_path, args) => ({ exit_code: 0,
    stdout: args[0] === "remote" ? "git@github.com:RankOneLabs/oakridge.git\n" : args[1] === "HEAD" ? "sha\n" : "/repo\n", stderr: "" }) };
  expect(await new RepositoryPreparationOperation(git).execute({ repository_path: "/repo/", expected_head: null }))
    .toEqual({ kind: "acknowledged", value: { repository_path: "/repo/", head: "sha", push_remote_owner: "RankOneLabs" } });
});

test("repository preparation pins the selected head", async () => {
  const git: GitCommandRunner = { run: async (_path, args) => ({ exit_code: 0, stdout: args[1] === "HEAD" ? "new-sha\n" : "/repo\n", stderr: "" }) };
  expect(await new RepositoryPreparationOperation(git).execute({ repository_path: "/repo", expected_head: "selected-sha" }))
    .toMatchObject({ kind: "permanently_rejected", code: "head_changed" });
});

for (const status of [408, 409, 429, 503]) {
  test(`PR discovery HTTP ${status} remains retryable IO`, async () => {
    const http = (async () => new Response("unavailable", { status })) as unknown as typeof fetch;
    const reader = new GithubPullRequestReader({ token: "test" }, http);
    const result = await new PullRequestObservationOperation(reader).execute({ query: { owner: "owner", name: "repo", head_owner: "owner", head_branch: "head", base_branch: "base" } });
    expect(result.kind).toBe("transiently_unavailable");
  });
}
for (const status of [401, 403]) {
  test(`PR discovery HTTP ${status} permanently rejects with auth`, async () => {
    const http = (async () => new Response("unauthorized", { status })) as unknown as typeof fetch;
    const reader = new GithubPullRequestReader({ token: "test" }, http);
    const result = await new PullRequestObservationOperation(reader).execute({ query: { owner: "owner", name: "repo", head_owner: "owner", head_branch: "head", base_branch: "base" } });
    expect(result).toMatchObject({ kind: "permanently_rejected", code: "auth" });
  });
}

test("the invocation deadline aborts an in-flight git subprocess", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const operation = new BunGitCommandRunner().run(resolve(import.meta.dir, "../.."), ["-c", "alias.pause=!sleep 10", "pause"], { signal: controller.signal })
    .then((value) => ({ kind: "acknowledged" as const, value }));
  const result = await bounded(operation, 100, controller);
  expect({ kind: result.kind, aborted: controller.signal.aborted, elapsed_below_one_second: Date.now() - started < 1000 })
    .toEqual({ kind: "uncertain", aborted: true, elapsed_below_one_second: true });
});

test("the invocation deadline aborts an in-flight GitHub fetch", async () => {
  let was_aborted = false;
  const http = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { was_aborted = true; reject(new Error("aborted")); }, { once: true });
  })) as unknown as typeof fetch;
  const controller = new AbortController();
  const reader = new GithubPullRequestReader({ token: "test" }, http);
  const operation = new PullRequestObservationOperation(reader).execute({ query: { owner: "owner", name: "repo", head_owner: "owner", head_branch: "head", base_branch: "base" } }, { signal: controller.signal });
  const result = await bounded(operation, 100, controller);
  expect({ kind: result.kind, was_aborted }).toEqual({ kind: "uncertain", was_aborted: true });
});
