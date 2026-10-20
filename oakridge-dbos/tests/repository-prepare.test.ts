import { expect, test } from "bun:test";
import type { GitCommandOutcome, GitCommandRunner } from "../src/domain/repository-provisioning";
import { prepareRepository, type RepositoryPrepareInput } from "../src/operations/repository-prepare";

const INPUT: RepositoryPrepareInput = { repository_path: "/srv/repo", expected_head: null, base_branch: "epic/tiers", integration_branch: "main" };
const BASE_SHA = "b".repeat(40);
const ok = (stdout = ""): GitCommandOutcome => ({ exit_code: 0, stdout, stderr: "" });
const refused = (stderr: string): GitCommandOutcome => ({ exit_code: 1, stdout: "", stderr });

/** Answers each git command from a script, in order per command, and records what ran. */
function scriptedGit(origin: { readonly listings: readonly string[]; readonly push?: GitCommandOutcome }): GitCommandRunner & { readonly calls: string[] } {
  const listings = [...origin.listings];
  const calls: string[] = [];
  return { calls, async run(_path, args) {
    const command = args.join(" ");
    calls.push(command);
    if (command === "rev-parse --show-toplevel") return ok("/srv/repo\n");
    if (command === "rev-parse HEAD") return ok(`${"a".repeat(40)}\n`);
    if (command === "remote get-url --push origin") return ok("git@github.com:RankOneLabs/oakridge.git\n");
    if (args[0] === "ls-remote") return ok(listings.shift() ?? "");
    if (args[0] === "fetch") return ok();
    if (args[0] === "push") return origin.push ?? ok();
    if (command === "rev-parse --verify refs/remotes/origin/epic/tiers^{commit}") return ok(`${BASE_SHA}\n`);
    return refused(`unexpected git ${command}`);
  } };
}

const pushes = (calls: readonly string[]): string[] => calls.filter((call) => call.startsWith("push "));

test("a base branch already on origin is used as it is, never reseeded", async () => {
  const git = scriptedGit({ listings: [`${BASE_SHA}\trefs/heads/epic/tiers\n`] });
  const outcome = await prepareRepository(git, INPUT);
  expect({ outcome, pushes: pushes(git.calls) }).toEqual({
    outcome: { kind: "succeeded", body: { repository_path: "/srv/repo", push_remote_owner: "RankOneLabs", head: BASE_SHA } }, pushes: [] });
});

test("a missing base branch is cut from origin's integration branch and pushed", async () => {
  const git = scriptedGit({ listings: [""] });
  const outcome = await prepareRepository(git, INPUT);
  expect({ kind: outcome.kind, pushes: pushes(git.calls) }).toEqual({ kind: "succeeded", pushes: ["push origin refs/remotes/origin/main:refs/heads/epic/tiers"] });
});

test("a push lost to a concurrent seeder succeeds on the branch that seeder made", async () => {
  const git = scriptedGit({ listings: ["", `${BASE_SHA}\trefs/heads/epic/tiers\n`], push: refused("rejected: already exists") });
  expect((await prepareRepository(git, INPUT)).kind).toBe("succeeded");
});

test("a push origin refuses fails the preparation with origin's reason", async () => {
  const git = scriptedGit({ listings: ["", ""], push: refused("permission denied") });
  expect(await prepareRepository(git, INPUT)).toEqual({ kind: "failed", code: "provider_rejected",
    detail: "could not create epic/tiers on origin: permission denied" });
});
