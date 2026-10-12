import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { bounded } from "../src/effects/outcomes";
import { GithubPullRequestReader } from "../src/runtime/github-pull-requests";
import { BunGitCommandRunner } from "../src/runtime/git-command-runner";

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
  const operation = reader.find_for_branches({ owner: "owner", name: "repo", head_owner: "owner", head_branch: "head", base_branch: "base" }, { signal: controller.signal })
    .then((value) => ({ kind: "acknowledged" as const, value }));
  const result = await bounded(operation, 100, controller);
  expect({ kind: result.kind, was_aborted }).toEqual({ kind: "uncertain", was_aborted: true });
});
