import { expect, test } from "bun:test";

import type { CohortId, RepositoryKey } from "../src/domain/primitives";
import { describeRepositoryProvisioningFailure, provisionFailureFromAdapter, provisionRepositoryRefs, type GitCommandOutcome, type GitCommandRunner, type RepositoryProvisioningFailure } from "../src/domain/repository-provisioning";
import { parseBaseBranch, parseRunContextRepository, selectBaseBranch, type RunContextRepository } from "../src/domain/repository-refs";
import { runExclusive } from "../src/runtime/keyed-mutex";

const repository: RunContextRepository = { key: "scout", path: "/repos/scout", integration_branch: "main", forge_repository: null };
const BASE_BRANCH = "epic/response-edits";
const provision = (git: GitCommandRunner, overrides: { readonly integration_branch?: string } = {}) =>
  provisionRepositoryRefs({ repository: { ...repository, ...overrides }, base_branch: BASE_BRANCH }, git);
const EPIC_HEAD = "94b43e4ab2c2ea1c44acb546534cb8df0aea92c6";

test("all repository failures retain their adapter evidence and cohort identity", () => {
  const failures: readonly RepositoryProvisioningFailure[] = [
    { kind: "not_a_git_repository", repository_key: "scout", repository_path: "/repos/scout" },
    { kind: "missing_integration_branch", repository_key: "scout", repository_path: "/repos/scout", integration_branch: "main", detail: "missing" },
    { kind: "base_branch_unavailable", repository_key: "scout", repository_path: "/repos/scout", base_branch: BASE_BRANCH, detail: "denied" },
    { kind: "git_command_failed", repository_key: "scout", repository_path: "/repos/scout", command: "git fetch", detail: "offline" },
  ];
  for (const failure of failures) {
    expect(provisionFailureFromAdapter({ cohort_id: "cohort-1" as CohortId,
      repository_key: "scout" as RepositoryKey, failure })).toEqual(expect.objectContaining({
      operation: "provision_repository_refs", cohort_id: "cohort-1", repository_key: "scout",
      kind: failure.kind, detail: describeRepositoryProvisioningFailure(failure), evidence: failure,
    }));
  }
});

/** A git that answers from a script, and records the commands it was asked for. */
const scriptedGit = (script: (args: readonly string[], call: number) => Partial<GitCommandOutcome> | undefined) => {
  const commands: string[][] = [];
  const runner: GitCommandRunner = {
    async run(_path, args) {
      commands.push([...args]);
      const seen = commands.filter((candidate) => candidate.join(" ") === args.join(" ")).length;
      return { exit_code: 0, stdout: "", stderr: "", ...script(args, seen) };
    },
  };
  return { runner, commands: () => commands.map((args) => args.join(" ")) };
};

/** The happy answers for a repository whose epic branch is already published. */
const publishedEpic = (args: readonly string[]): Partial<GitCommandOutcome> | undefined => {
  if (args[0] === "ls-remote") return { stdout: `${EPIC_HEAD}\trefs/heads/epic/response-edits\n` };
  if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: `${EPIC_HEAD}\n` };
  return undefined;
};

test("an epic branch already on origin is fetched, never reseeded from the base branch", async () => {
  const git = scriptedGit(publishedEpic);
  const provisioned = await provision(git.runner);
  expect(provisioned).toEqual({ ok: true, value: { repository_key: "scout", repository_path: "/repos/scout",
    integration_branch: "main", base_branch: "epic/response-edits", base_head_sha: EPIC_HEAD } });
  // The push is the reseed. An epic every cohort has already merged into would
  // be silently rewound to the base branch by one.
  expect(git.commands().some((command) => command.startsWith("push"))).toBe(false);
  expect(git.commands()).toEqual([
    "rev-parse --git-dir",
    "ls-remote origin refs/heads/epic/response-edits",
    "fetch origin +refs/heads/epic/response-edits:refs/remotes/origin/epic/response-edits",
    "rev-parse --verify origin/epic/response-edits^{commit}",
  ]);
});

test("an absent epic branch is seeded from origin's base branch under an explicit refspec", async () => {
  const git = scriptedGit((args, call) => {
    // Absent on the first look, published by our own push on the second.
    if (args[0] === "ls-remote") return call === 1 ? { stdout: "" } : { stdout: `${EPIC_HEAD}\trefs/heads/epic/response-edits\n` };
    if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: `${EPIC_HEAD}\n` };
    return undefined;
  });
  const provisioned = await provision(git.runner);
  expect(provisioned.ok).toBe(true);
  // The refspec is explicit so the epic can never inherit a stale local main,
  // and the push reads the remote-tracking ref rather than any local branch.
  expect(git.commands()).toEqual([
    "rev-parse --git-dir",
    "ls-remote origin refs/heads/epic/response-edits",
    "fetch origin +refs/heads/main:refs/remotes/origin/main",
    "push origin origin/main:refs/heads/epic/response-edits",
    "fetch origin +refs/heads/epic/response-edits:refs/remotes/origin/epic/response-edits",
    "rev-parse --verify origin/epic/response-edits^{commit}",
  ]);
});

test("a push lost to a concurrent seeder is re-checked and accepted", async () => {
  const git = scriptedGit((args, call) => {
    if (args[0] === "ls-remote") return call === 1 ? { stdout: "" } : { stdout: `${EPIC_HEAD}\trefs/heads/epic/response-edits\n` };
    if (args[0] === "push") return { exit_code: 1, stderr: "! [rejected] fetch first" };
    if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: `${EPIC_HEAD}\n` };
    return undefined;
  });
  const provisioned = await provision(git.runner);
  expect(provisioned).toEqual({ ok: true, value: expect.objectContaining({ base_head_sha: EPIC_HEAD }) });
  expect(git.commands().filter((command) => command.startsWith("ls-remote"))).toHaveLength(2);
});

test("a push that fails with the branch still absent reports the push, not the symptom", async () => {
  const git = scriptedGit((args) => {
    if (args[0] === "ls-remote") return { stdout: "" };
    if (args[0] === "push") return { exit_code: 1, stderr: "remote: Permission to cirsteve/scout.git denied" };
    return undefined;
  });
  const provisioned = await provision(git.runner);
  expect(provisioned).toEqual({ ok: false, error: expect.objectContaining({ kind: "base_branch_unavailable" }) });
  if (!provisioned.ok) expect(describeRepositoryProvisioningFailure(provisioned.error)).toContain("Permission to cirsteve/scout.git denied");
});

test("a directory that is not a git repository is reported before any branch is", async () => {
  const git = scriptedGit((args) => (args[0] === "rev-parse" && args[1] === "--git-dir" ? { exit_code: 128, stderr: "not a git repository" } : undefined));
  const provisioned = await provision(git.runner);
  expect(provisioned).toEqual({ ok: false, error: { kind: "not_a_git_repository", repository_key: "scout", repository_path: "/repos/scout" } });
  // Reporting a missing branch for a directory that is not a repository would
  // send an operator looking for the wrong thing.
  expect(git.commands()).toEqual(["rev-parse --git-dir"]);
});

test("an integration branch origin does not have is named as such, not as the base branch", async () => {
  const git = scriptedGit((args) => {
    if (args[0] === "ls-remote") return { stdout: "" };
    if (args[0] === "fetch") return { exit_code: 128, stderr: "fatal: couldn't find remote ref refs/heads/trunk" };
    return undefined;
  });
  const provisioned = await provision(git.runner, { integration_branch: "trunk" });
  expect(provisioned).toEqual({ ok: false, error: expect.objectContaining({ kind: "missing_integration_branch", integration_branch: "trunk" }) });
  if (!provisioned.ok) expect(describeRepositoryProvisioningFailure(provisioned.error)).toContain("has no integration branch 'trunk'");
});

/**
 * The final fetch exists so `git rev-parse origin/<epic>` resolves later, when
 * the build stage cuts a worktree from it. Losing it is how a run that
 * provisioned successfully still failed at its first cohort.
 */
test("provisioning ends with the local tracking ref resolvable", async () => {
  const git = scriptedGit((args) => {
    if (args[0] === "ls-remote") return { stdout: `${EPIC_HEAD}\trefs/heads/epic/response-edits\n` };
    if (args[0] === "rev-parse" && args[1] === "--verify") return { exit_code: 128, stderr: "unknown revision" };
    return undefined;
  });
  const provisioned = await provision(git.runner);
  expect(provisioned).toEqual({ ok: false, error: expect.objectContaining({ kind: "git_command_failed",
    command: "git rev-parse --verify origin/epic/response-edits^{commit}" }) });
});

test("a run context repository is parsed, so a missing field is named where it is missing", () => {
  expect(parseRunContextRepository({ key: "scout", path: "/repos/scout", integration_branch: "main" }))
    .toEqual({ ok: true, value: { key: "scout", path: "/repos/scout", integration_branch: "main", forge_repository: null } });
  expect(parseRunContextRepository({ key: "scout", path: "/repos/scout", integration_branch: "main",
    forge_repository: { provider: "github", owner: "RankOneLabs", name: "scout" } }))
    .toEqual({ ok: true, value: { key: "scout", path: "/repos/scout", integration_branch: "main",
      forge_repository: { provider: "github", owner: "RankOneLabs", name: "scout" } } });
  expect(parseRunContextRepository({ key: "scout", path: "/repos/scout", integration_branch: "main",
    forge_repository: { provider: "github", owner: "RankOneLabs" } }))
    .toEqual({ ok: false, error: expect.objectContaining({ detail: "repository 'forge_repository' must be {provider:'github',owner,name}" }) });
  expect(parseRunContextRepository({ key: "scout", path: "/repos/scout" }))
    .toEqual({ ok: false, error: expect.objectContaining({ detail: "repository 'integration_branch' must be a non-empty string" }) });
  expect(parseRunContextRepository([{ key: "scout" }]))
    .toEqual({ ok: false, error: expect.objectContaining({ detail: "repository must be a JSON object" }) });
});

test("the epic branch default is the epic slug unless the repository names one", () => {
  expect(selectBaseBranch("epic/custom", "tiers-page")).toBe("epic/custom");
  expect(selectBaseBranch(null, "tiers-page")).toBe("epic/tiers-page");
  expect(selectBaseBranch(undefined, "tiers-page")).toBe("epic/tiers-page");
});

/**
 * Two runs seeding epic branches in the same working copy race `git fetch`, and
 * the loser dies on "cannot lock ref". Distinct repositories must not pay for
 * that serialization.
 */
test("provisioning serializes per working copy and leaves other repositories parallel", async () => {
  const order: string[] = [];
  const hold = async (key: string, ms: number) => runExclusive(key, async () => {
    order.push(`${key}:start`);
    await Bun.sleep(ms);
    order.push(`${key}:end`);
  });
  await Promise.all([hold("/repos/scout", 20), hold("/repos/scout", 0), hold("/repos/other", 0)]);
  expect(order.slice(0, 2)).toEqual(["/repos/scout:start", "/repos/other:start"]);
  expect(order.indexOf("/repos/scout:end")).toBeLessThan(order.lastIndexOf("/repos/scout:start"));
});

test("a failing exclusive operation does not poison the next waiter on the same key", async () => {
  await expect(runExclusive("/repos/scout", async () => { throw new Error("git exploded"); })).rejects.toThrow("git exploded");
  expect(await runExclusive("/repos/scout", async () => "next runs")).toBe("next runs");
});

/**
 * The launch boundary types `base_branch` when a launch names that key, but a
 * definition may bind the provisioning stage's branch to anything — another
 * context pointer, an upstream input — and binding resolution stringifies
 * whatever it finds. So the check belongs where the value is used, not only
 * where one spelling of it enters.
 */
test("a resolved base branch that is not a branch name is refused rather than pushed", () => {
  // Whitespace-only is refused too, but for its own reason — see the padded test below.
  for (const notABranch of [null, 42, { name: "epic/x" }, ""]) {
    expect(parseBaseBranch(notABranch as never)).toEqual({ ok: false,
      error: expect.objectContaining({ operation: "parse_base_branch", detail: expect.stringContaining("must resolve to a non-empty string") }) });
  }
  expect(parseBaseBranch("epic/tiers-page")).toEqual({ ok: true, value: "epic/tiers-page" });
});

/**
 * Refused rather than trimmed. Repairing it would leave the run context naming
 * one branch and git receiving another — the exact disagreement this rename
 * exists to remove.
 */
test("a padded base branch is refused rather than quietly repaired", () => {
  for (const padded of [" epic/tiers-page", "epic/tiers-page ", "  epic/tiers-page  ", "   "]) {
    expect(parseBaseBranch(padded)).toEqual({ ok: false,
      error: expect.objectContaining({ operation: "parse_base_branch" }) });
  }
  expect(parseBaseBranch(" epic/x ")).toEqual({ ok: false,
    error: expect.objectContaining({ detail: expect.stringContaining("leading or trailing whitespace") }) });
});
