import { expect, test } from "bun:test";

import { RepositoryProvisioningAdapter } from "../src/adapters/repository-provisioning";
import type { ExecutionRequest } from "../src/domain/execution";
import type { ExecutionId, JsonValue, StageInstanceId, UnitId } from "../src/domain/primitives";
import { describeRepositoryProvisioningFailure, provisionRepositoryRefs, type GitCommandOutcome, type GitCommandRunner } from "../src/domain/repository-provisioning";
import { parseResolvedRepositoryProvisioningConfig, parseRunContextRepository, selectBaseBranch } from "../src/domain/repository-refs";
import type { EmitExecutionArtifactRequest } from "../src/runtime/emit-artifact";
import { runExclusive } from "../src/runtime/keyed-mutex";

const repository = { key: "scout", path: "/repos/scout", integration_branch: "main" };
const BASE_BRANCH = "epic/response-edits";
const provision = (git: GitCommandRunner, overrides: { readonly integration_branch?: string } = {}) =>
  provisionRepositoryRefs({ repository: { ...repository, ...overrides }, base_branch: BASE_BRANCH }, git);
const EPIC_HEAD = "94b43e4ab2c2ea1c44acb546534cb8df0aea92c6";

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
    "fetch origin epic/response-edits",
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
    "fetch origin epic/response-edits",
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

const executionRequest = (resolved_config: JsonValue): ExecutionRequest => ({
  execution_id: "stage-1:scout" as ExecutionId,
  stage_instance_id: "11111111-1111-4111-8111-111111111111" as StageInstanceId,
  unit_id: "scout" as UnitId,
  executor_type: "provision_repository_refs",
  resolved_config,
  inputs: [],
  declared_outputs: [{ name: "repository_refs", artifact_type: "dev.repository_refs", required: true }],
  expected_artifacts: [{ unit_id: "scout" as UnitId, output_name: "repository_refs", artifact_type: "dev.repository_refs" }],
});

const resolvedConfig = { executor_type: "provision_repository_refs", output_name: "repository_refs", base_branch: BASE_BRANCH, repository } as unknown as JsonValue;

const adapterWith = (git: GitCommandRunner) => {
  const emitted: EmitExecutionArtifactRequest[] = [];
  const adapter = new RepositoryProvisioningAdapter({
    git,
    async emit(request) {
      emitted.push(request);
      return { ok: true, value: { artifact: { id: "artifact-1" } as never, release: { kind: "released", artifact: {} as never }, superseded_artifact_id: null } };
    },
  });
  return { adapter, emitted };
};

/**
 * The outcome travels in the reference, which is the value the execution
 * workflow checkpoints. An adapter remembering it in a map instead would answer
 * correctly until a restart or a rerun replayed the start step from its journal
 * into an empty process.
 */
test("the provisioning executor carries its outcome in the reference it returns", async () => {
  const git = scriptedGit(publishedEpic);
  const subject = adapterWith(git.runner);
  const request = executionRequest(resolvedConfig);
  const reference = await subject.adapter.start_or_attach(request, "attempt-1");
  expect(reference).toEqual({ kind: "completed", observation: { kind: "succeeded", metadata: { base_branch: "epic/response-edits", base_head_sha: EPIC_HEAD } } });
  expect(subject.emitted).toEqual([expect.objectContaining({ output_name: "repository_refs", unit_id: "scout",
    idempotency_key: "stage-1:scout:repository_refs", body: expect.objectContaining({ base_head_sha: EPIC_HEAD }) })]);

  // A second adapter — standing in for the process after a restart — reports
  // the same terminal state from the reference alone.
  const observed = await adapterWith(git.runner).adapter.observe_terminal(request.execution_id, reference);
  expect(observed).toEqual({ kind: "terminal", observation: { kind: "succeeded", metadata: { base_branch: "epic/response-edits", base_head_sha: EPIC_HEAD } } });
});

/**
 * A git failure is this unit's terminal outcome, not an exception. Throwing
 * inside the retrying step that carries it kills the observer and leaves the
 * execution waiting on a message that can no longer arrive.
 */
test("a provisioning failure becomes a named terminal observation rather than a throw", async () => {
  const git = scriptedGit((args) => (args[0] === "rev-parse" && args[1] === "--git-dir" ? { exit_code: 128 } : undefined));
  const subject = adapterWith(git.runner);
  const reference = await subject.adapter.start_or_attach(executionRequest(resolvedConfig), "attempt-1");
  expect(reference).toEqual({ kind: "completed", observation: { kind: "failed", code: "not_a_git_repository",
    detail: "repository 'scout' is not a git repository at /repos/scout" } });
  expect(subject.emitted).toEqual([]);
});

test("a resolved config the executor cannot read fails the unit rather than the process", async () => {
  const subject = adapterWith(scriptedGit(publishedEpic).runner);
  const reference = await subject.adapter.start_or_attach(executionRequest({ executor_type: "provision_repository_refs", output_name: "repository_refs", base_branch: BASE_BRANCH, repository: { key: "scout" } }), "attempt-1");
  expect(reference).toEqual({ kind: "completed", observation: expect.objectContaining({ code: "invalid_resolved_config" }) });
});

test("an observation with no completed reference says so rather than reporting success", async () => {
  const subject = adapterWith(scriptedGit(publishedEpic).runner);
  expect(await subject.adapter.observe_terminal("stage-1:scout" as ExecutionId, { kind: "none" }))
    .toEqual({ kind: "terminal", observation: expect.objectContaining({ code: "provisioning_not_started" }) });
});

test("a run context repository is parsed, so a missing field is named where it is missing", () => {
  expect(parseRunContextRepository({ key: "scout", path: "/repos/scout", integration_branch: "main" }))
    .toEqual({ ok: true, value: { key: "scout", path: "/repos/scout", integration_branch: "main" } });
  expect(parseRunContextRepository({ key: "scout", path: "/repos/scout" }))
    .toEqual({ ok: false, error: expect.objectContaining({ detail: "repository 'integration_branch' must be a non-empty string" }) });
  expect(parseRunContextRepository([{ key: "scout" }]))
    .toEqual({ ok: false, error: expect.objectContaining({ detail: "repository must be a JSON object" }) });
});

test("a resolved provisioning config refuses a payload belonging to another executor", () => {
  expect(parseResolvedRepositoryProvisioningConfig({ executor_type: "delegated_session", output_name: "x", repository } as unknown as JsonValue))
    .toEqual({ ok: false, error: expect.objectContaining({ detail: "resolved config is not a 'provision_repository_refs' config" }) });
});

/**
 * One selector, because the epic profile the operator reads and the run context
 * the stages read both need the default — and a default that drifts between
 * them names two different branches for the same run.
 */
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
