import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { prepareRepository } from "../src/operations/repository-prepare";
import type { OperationOutcome } from "../src/operations/outcome";
import { BunGitCommandRunner } from "../src/runtime/git-command-runner";

const runner = new BunGitCommandRunner();
let root: string;
let checkout: string;
let develop_head: string;
let checkout_head: string;

async function git(...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

const commit = (message: string) => git("-C", checkout, "-c", "user.email=t@oakridge.test", "-c", "user.name=t", "-c", "commit.gpgsign=false",
  "commit", "-q", "--allow-empty", "-m", message);

/** Origin has `main` and a `develop` one commit ahead; the checkout sits on `main` with a local commit origin never saw. */
beforeAll(async () => {
  root = mkdtempSync(resolve(tmpdir(), "oakridge-prepare-"));
  checkout = resolve(root, "work");
  const origin = resolve(root, "origin.git");
  await git("init", "-q", "--bare", "-b", "main", origin);
  await git("init", "-q", "-b", "main", checkout);
  await commit("base");
  await git("-C", checkout, "remote", "add", "origin", origin);
  await git("-C", checkout, "remote", "set-url", "--push", "origin", "git@github.com:oakridge-test/app.git");
  await git("-C", checkout, "push", "-q", origin, "main");
  await git("-C", checkout, "checkout", "-q", "-b", "develop");
  await commit("develop work");
  develop_head = await git("-C", checkout, "rev-parse", "HEAD");
  await git("-C", checkout, "push", "-q", origin, "develop");
  await git("-C", checkout, "checkout", "-q", "main");
  await commit("local only");
  checkout_head = await git("-C", checkout, "rev-parse", "HEAD");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const failureCode = (outcome: OperationOutcome): string => outcome.kind === "failed" ? outcome.code : outcome.kind;

test("the prepared head is the base branch's tip on origin, not the checkout's HEAD", async () => {
  const outcome = await prepareRepository(runner, { repository_path: checkout, base_branch: "develop", expected_head: null });
  expect({ outcome, differs_from_checkout: develop_head !== checkout_head })
    .toEqual({ outcome: { kind: "succeeded", body: { repository_path: checkout, push_remote_owner: "oakridge-test", head: develop_head } },
      differs_from_checkout: true });
});

test("a base branch origin does not have fails as base_branch_missing", async () => {
  const outcome = await prepareRepository(runner, { repository_path: checkout, base_branch: "epic/absent", expected_head: null });
  expect(failureCode(outcome)).toBe("base_branch_missing");
});

test("a base branch that is not a valid branch name fails before reaching origin", async () => {
  const outcome = await prepareRepository(runner, { repository_path: checkout, base_branch: "bad..name", expected_head: null });
  expect(failureCode(outcome)).toBe("base_branch_missing");
});

test("an expected head is checked against the base branch's tip", async () => {
  const outcomes = await Promise.all([
    prepareRepository(runner, { repository_path: checkout, base_branch: "develop", expected_head: develop_head }),
    prepareRepository(runner, { repository_path: checkout, base_branch: "develop", expected_head: checkout_head }),
  ]);
  expect(outcomes.map(failureCode)).toEqual(["succeeded", "head_changed"]);
});
