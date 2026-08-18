/**
 * Nothing creates the epic branch a run is configured with, and the first
 * stage that needs it is `build`. A run therefore completed spec analysis,
 * planning and briefing — three agent sessions, three operator approvals —
 * before failing on a branch that was never going to exist, behind a generic
 * session error that named neither the branch nor the repository.
 *
 * These are cheap local reads, so the launch is the place to ask.
 */
import { expect, test } from "bun:test";

import {
  describeRepositoryPreconditionFailure, describeRepositoryPreconditionFailures, selectRepositoryPreconditions,
  type RepositoryPrecondition,
} from "../src/domain/repository-preconditions";
import { GitRepositoryPreconditionChecker } from "../src/runtime/git-repository-preconditions";

const repository: RepositoryPrecondition = {
  repository_key: "pipefitter", repository_path: "/repos/pipefitter",
  base_branch: "main", epic_branch: "epic/tiers-page",
};

/** Git that resolves only the refs it is given. */
const gitKnowing = (refs: readonly string[], isRepository = true) =>
  async (_dir: string, args: readonly string[]): Promise<boolean> => {
    if (args[1] === "--git-dir") return isRepository;
    const ref = String(args[2] ?? "").replace("^{commit}", "");
    return refs.includes(ref);
  };

test("a repository with both branches raises nothing", async () => {
  const checker = new GitRepositoryPreconditionChecker(gitKnowing(["main", "epic/tiers-page"]));
  expect(await checker.check([repository])).toEqual([]);
});

test("a missing epic branch is reported against the repository that lacks it", async () => {
  const checker = new GitRepositoryPreconditionChecker(gitKnowing(["main"]));
  expect(await checker.check([repository])).toEqual([
    { kind: "missing_ref", repository_key: "pipefitter", repository_path: "/repos/pipefitter", role: "epic_branch", ref: "epic/tiers-page", create_from: "main" },
  ]);
});

test("a missing base branch is reported too, since the final pull request needs it", async () => {
  const checker = new GitRepositoryPreconditionChecker(gitKnowing(["epic/tiers-page"]));
  const failures = await checker.check([repository]);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ role: "base_branch", ref: "main" });
});

/** Reporting a missing branch for a directory that is not a repository misdirects. */
test("a path that is not a repository is reported once, not as two missing branches", async () => {
  const checker = new GitRepositoryPreconditionChecker(gitKnowing([], false));
  expect(await checker.check([repository])).toEqual([
    { kind: "not_a_git_repository", repository_key: "pipefitter", repository_path: "/repos/pipefitter" },
  ]);
});

test("every repository is checked, not just the first to fail", async () => {
  const checker = new GitRepositoryPreconditionChecker(gitKnowing(["main"]));
  const failures = await checker.check([repository, { ...repository, repository_key: "oakridge", epic_branch: "epic/other" }]);
  expect(failures.map((failure) => failure.repository_key)).toEqual(["pipefitter", "oakridge"]);
});

test("the failure names the remedy, not just the symptom", () => {
  const message = describeRepositoryPreconditionFailure({
    kind: "missing_ref", repository_key: "pipefitter", repository_path: "/repos/pipefitter",
    role: "epic_branch", ref: "epic/tiers-page", create_from: "main",
  });
  expect(message).toContain("epic branch 'epic/tiers-page'");
  expect(message).toContain("git -C /repos/pipefitter branch epic/tiers-page origin/main");
});

test("several failures read as one message", () => {
  const message = describeRepositoryPreconditionFailures([
    { kind: "not_a_git_repository", repository_key: "a", repository_path: "/a" },
    { kind: "missing_ref", repository_key: "b", repository_path: "/b", role: "base_branch", ref: "main", create_from: null },
  ]);
  expect(message).toContain("repository 'a' is not a git repository");
  expect(message).toContain("repository 'b' has no base branch 'main'");
});

test("the repositories to check are read off the prepared run context", () => {
  expect(selectRepositoryPreconditions({
    repositories: [{ key: "pipefitter", path: "/repos/pipefitter", base_branch: "main", epic_branch: "epic/tiers-page" }],
  })).toEqual([repository]);
});

/** A run with no epic profile declares no repositories and assumes nothing. */
test("a context without repositories yields nothing to check", () => {
  for (const context of [{}, null, "nope", { repositories: "not a list" }, { repositories: [{ key: "only" }] }]) {
    expect(selectRepositoryPreconditions(context)).toEqual([]);
  }
});
