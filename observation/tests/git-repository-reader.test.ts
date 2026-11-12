import { questionVersion } from "./grading-fixture";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactRevisionId, ItemOccurrenceId, RunId } from "../src/domain/identity";
import type { CapturedSources, SourceArtifact } from "../src/ports/artifact-source";
import { oakridgeEvidence } from "./grading-fixture";
import { EVIDENCE_SUPPORT_ID } from "./grading-fixture";
import { createGitRepositoryReader } from "../src/storage/git-repository-reader";

let root = "";
let primary = "";
let other = "";
let cited_commit = "";
let primary_commit = "";

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
async function repository(name: string, files: Record<string, string>): Promise<{ path: string; commit: string }> {
  const path = join(root, name);
  git(root, "init", "--quiet", path);
  for (const [file, content] of Object.entries(files)) await Bun.write(join(path, file), content);
  git(path, "add", ".");
  git(path, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
  return { path, commit: git(path, "rev-parse", "HEAD") };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "observation-git-"));
  const first = await repository("primary", { "src/alpha.ts": "primary\n" });
  const second = await repository("other", { "core/decision-record.ts": Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n") });
  primary = first.path; primary_commit = first.commit; other = second.path; cited_commit = second.commit;
  // The worktree moves on after the cited commit; evidence must still read the commit.
  await Bun.write(join(other, "core/decision-record.ts"), "edited in the worktree\n");
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

test("a file is read at the exact commit, not from the worktree", async () => {
  const file = await createGitRepositoryReader().readFile({ repository_path: other, commit_sha: cited_commit, path: "core/decision-record.ts" });
  expect(file.state === "present" && file.content.split("\n")[17]).toBe("line 18");
});

test("a path missing from a readable commit is absent; an unreadable commit or repository is unavailable", async () => {
  const reader = createGitRepositoryReader();
  expect(await reader.readFile({ repository_path: other, commit_sha: cited_commit, path: "core/gone.ts" })).toEqual({ state: "absent" });
  expect(await reader.readFile({ repository_path: other, commit_sha: primary_commit, path: "core/decision-record.ts" }))
    .toMatchObject({ state: "unavailable" });
  expect(await reader.readFile({ repository_path: join(root, "missing"), commit_sha: cited_commit, path: "x" })).toMatchObject({ state: "unavailable" });
  expect(await reader.hasCommit(other, "not-a-sha; rm -rf /")).toBe(false);
});

/** Deletes a loose object, as a damaged or partially fetched clone would lack it. */
async function removeObject(repository_path: string, object: string): Promise<void> {
  const id = git(repository_path, "rev-parse", object);
  await rm(join(repository_path, ".git", "objects", id.slice(0, 2), id.slice(2)));
}

test("a readable commit whose tree or file object is missing makes the lookup unavailable, never absent", async () => {
  const damaged = await repository("damaged", { "deep/inner.ts": "inner\n", "flat.ts": "flat\n" });
  await removeObject(damaged.path, `${damaged.commit}:deep`);
  await removeObject(damaged.path, `${damaged.commit}:flat.ts`);
  const reader = createGitRepositoryReader();
  expect(await reader.readFile({ repository_path: damaged.path, commit_sha: damaged.commit, path: "deep/inner.ts" }))
    .toMatchObject({ state: "unavailable" });
  expect(await reader.readFile({ repository_path: damaged.path, commit_sha: damaged.commit, path: "flat.ts" }))
    .toMatchObject({ state: "unavailable" });
  expect(await reader.readFile({ repository_path: damaged.path, commit_sha: damaged.commit, path: "gone.ts" })).toEqual({ state: "absent" });
});

test("a failed listing is unavailable and only an empty one is absent", async () => {
  const commit = "a".repeat(40);
  const reader = (listing: { code: number; stdout: string }) => createGitRepositoryReader(async (_path, args) =>
    args.includes("ls-tree") ? { ...listing, stderr: "fatal: unable to read tree" }
      : args[1] === "-p" ? { code: 0, stdout: "content", stderr: "" } : { code: 0, stdout: "", stderr: "" });
  const request = { repository_path: "/r", commit_sha: commit, path: "src/a.ts" };
  expect(await reader({ code: 128, stdout: "" }).readFile(request)).toEqual({ state: "unavailable", detail: "fatal: unable to read tree" });
  expect(await reader({ code: 0, stdout: "" }).readFile(request)).toEqual({ state: "absent" });
  expect(await reader({ code: 0, stdout: "100644 blob abc\tsrc/a.ts\0" }).readFile(request)).toEqual({ state: "present", content: "content" });
});

test("a path that leaves the tree never addresses a file", async () => {
  expect(await createGitRepositoryReader().readFile({ repository_path: other, commit_sha: cited_commit, path: "../primary/src/alpha.ts" }))
    .toEqual({ state: "absent" });
});

test("the collector reads a citation range from the non-primary launch repository holding head_sha", async () => {
  const artifact: SourceArtifact = { occurrence_id: "occurrence" as ItemOccurrenceId, run_id: "run-1" as RunId, revision_id: "assessment-1" as ArtifactRevisionId,
    item_path: "/findings/0", item_kind: "assessment_finding",
    selected_value: { task_ids: [], evidence: [{ kind: "file", ref: "core/decision-record.ts:18-31" }, { kind: "file", ref: "core/gone.ts" }] } };
  const sources: CapturedSources = { repository: createGitRepositoryReader(), readRevisionAt: async () => null, readLogicalItemAt: async () => ({ revision_id: "tasks-1" as ArtifactRevisionId, item_path: "/tasks/0", item_kind: "task", selected_value: { id: "T7" } }), readLinkedItems: async () => [],
    readRunInput: async () => ({ spec: "s", primary_repository_key: "primary", repositories: [
      { key: "primary", preparation: { repository_path: primary } }, { key: "other", preparation: { repository_path: other } }] }),
    readRevision: async (revision_id) => ({ revision_id: revision_id as ArtifactRevisionId, artifact_kind: "assessment", subject_id: null, body: { head_sha: cited_commit } }) };
  const collected = await oakridgeEvidence.collect(artifact, { task_id: "task-7" as import("../src/domain/identity").LogicalItemId, question_id: EVIDENCE_SUPPORT_ID, question_version: questionVersion(EVIDENCE_SUPPORT_ID) }, sources);
  expect(collected).toMatchObject({ state: "ready", references: [{ ref: "subject" },
    { source: "repository", repository_key: "other", commit_sha: cited_commit, path: "core/decision-record.ts", line_range: { start: 18, end: 31 },
      is_absent: false, content: Array.from({ length: 14 }, (_, index) => `line ${index + 18}`).join("\n") },
    { source: "repository", repository_key: "other", commit_sha: cited_commit, path: "core/gone.ts", is_absent: true, content: null }, { ref: "task_context:0" }] });
});
