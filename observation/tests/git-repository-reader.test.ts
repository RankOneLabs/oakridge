import { questionVersion } from "./grading-fixture";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactRevisionId, ItemOccurrenceId, RunId } from "../src/domain/identity";
import type { JsonValue } from "../src/domain/primitives";
import type { CapturedSources, SourceArtifact } from "../src/ports/artifact-source";
import { oakridgeEvidence } from "./grading-fixture";
import { EVIDENCE_SUPPORT_ID } from "./grading-fixture";
import { createGitRepositoryReader } from "../src/storage/git-repository-reader";
import { CaptureArtifactSource } from "../src/storage/capture-artifact-source";
import { collectPinnedQuestion, readOccurrenceEvidence } from "../src/storage/captured-evidence-store";
import { registerEvaluator, registerQuestion } from "../src/storage/grading-store";
import { listRunItems } from "../src/storage/projection-store";
import { OAKRIDGE_QUESTIONS, createFeed, evaluator, evaluatorId, fixtureBody, integration, scopeOf, scratchDatabase, targetOf, tenant } from "./grading-fixture";

let root = "";
let primary = "";
let other = "";
let cited_commit = "";
let primary_commit = "";
let binary = "";
let binary_commit = "";
/** A PNG's opening bytes: its signature and header chunk carry NUL bytes, as every PNG does. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x04, 0x3d]);

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
async function repository(name: string, files: Record<string, string | Uint8Array>): Promise<{ path: string; commit: string }> {
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
  const third = await repository("binary", { "docs/demo.png": PNG, "README.md": "# Demo\n" });
  binary = third.path; binary_commit = third.commit;
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
  const bytes = (text: string) => new TextEncoder().encode(text);
  const reader = (listing: { code: number; stdout: string }) => createGitRepositoryReader(async (_path, args) =>
    args.includes("ls-tree") ? { ...listing, stdout: bytes(listing.stdout), stderr: "fatal: unable to read tree" }
      : args[1] === "-p" ? { code: 0, stdout: bytes("content"), stderr: "" } : { code: 0, stdout: bytes(""), stderr: "" });
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
    readRevision: async (revision_id) => ({ revision_id: revision_id as ArtifactRevisionId, stage: "implementation", artifact_kind: "assessment", subject_id: null, body: { head_sha: cited_commit } }) };
  const collected = await oakridgeEvidence.collect(artifact, { task_id: "task-7" as import("../src/domain/identity").LogicalItemId, question_id: EVIDENCE_SUPPORT_ID, question_version: questionVersion(EVIDENCE_SUPPORT_ID) }, sources);
  expect(collected).toMatchObject({ state: "ready", references: [{ ref: "subject" },
    { source: "repository", repository_key: "other", commit_sha: cited_commit, path: "core/decision-record.ts", line_range: { start: 18, end: 31 },
      is_absent: false, content: Array.from({ length: 14 }, (_, index) => `line ${index + 18}`).join("\n") },
    { source: "repository", repository_key: "other", commit_sha: cited_commit, path: "core/gone.ts", is_absent: true, content: null }, { ref: "task_context:0" }] });
});

test("a file holding a NUL byte is binary: present at its commit and sized, its bytes never decoded", async () => {
  const reader = createGitRepositoryReader();
  expect(await reader.readFile({ repository_path: binary, commit_sha: binary_commit, path: "docs/demo.png" }))
    .toEqual({ state: "binary", byte_size: PNG.byteLength });
});

test("a text file beside a binary one is still read as text", async () => {
  expect(await createGitRepositoryReader().readFile({ repository_path: binary, commit_sha: binary_commit, path: "README.md" }))
    .toEqual({ state: "present", content: "# Demo\n" });
});

const binaryFinding: JsonValue = { task_ids: ["T7"], criterion: "The demo is shown", status: "met",
  evidence: [{ kind: "file", ref: "docs/demo.png", detail: "PNG screenshot" }, { kind: "file", ref: "README.md" }] };

test("the collector cites a binary file as present, binary and sized, with no content", async () => {
  const artifact: SourceArtifact = { occurrence_id: "occurrence" as ItemOccurrenceId, run_id: "run-1" as RunId, revision_id: "assessment-1" as ArtifactRevisionId,
    item_path: "/findings/0", item_kind: "assessment_finding", selected_value: binaryFinding };
  const sources: CapturedSources = { repository: createGitRepositoryReader(), readRevisionAt: async () => null, readLinkedItems: async () => [],
    readLogicalItemAt: async () => ({ revision_id: "tasks-1" as ArtifactRevisionId, item_path: "/tasks/0", item_kind: "task", selected_value: { id: "T7" } }),
    readRunInput: async () => ({ spec: "s", primary_repository_key: "binary", repositories: [{ key: "binary", preparation: { repository_path: binary } }] }),
    readRevision: async (revision_id) => ({ revision_id: revision_id as ArtifactRevisionId, stage: "implementation", artifact_kind: "assessment", subject_id: null, body: { head_sha: binary_commit } }) };
  const collected = await oakridgeEvidence.collect(artifact, { task_id: "task-7" as import("../src/domain/identity").LogicalItemId, question_id: EVIDENCE_SUPPORT_ID, question_version: questionVersion(EVIDENCE_SUPPORT_ID) }, sources);
  expect(collected).toMatchObject({ state: "ready", references: [{ ref: "subject" },
    { ref: "citation:0", source: "repository", path: "docs/demo.png", is_absent: false, is_binary: true, byte_size: PNG.byteLength, content: null },
    { ref: "citation:1", source: "repository", path: "README.md", is_absent: false, is_binary: false, byte_size: null, content: "# Demo\n" }, { ref: "task_context:0" }] });
});

integration("a cited binary file freezes as ready evidence instead of failing the jsonb write", async () => scratchDatabase(async (db) => {
  const question = OAKRIDGE_QUESTIONS.find((candidate) => candidate.question_id === EVIDENCE_SUPPORT_ID)!;
  await registerQuestion(db, tenant, question);
  await registerEvaluator(db, tenant, evaluator("human"));
  const feed = createFeed(db, tenant, { pins: [{ ...scopeOf(EVIDENCE_SUPPORT_ID), ...question, ...targetOf(EVIDENCE_SUPPORT_ID), evaluator_definition_ids: [evaluatorId("human")] }] });
  await feed.launch({ spec: "s", primary_repository_key: "binary", repositories: [{ key: "binary", preparation: { repository_path: binary } }] });
  await feed.revision({ revision_id: "tasks-1", artifact_kind: "tasks", body: await fixtureBody("tasks") });
  await feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment",
    body: { ...(await fixtureBody("assessment") as { readonly [key: string]: JsonValue }), head_sha: binary_commit, findings: [binaryFinding] } });
  const occurrence = (await listRunItems(db, tenant, "run-1", { limit: 50, offset: 0 })).items.find((item) => item.item_kind === "assessment_finding")!;
  const [pinned] = await readOccurrenceEvidence(db, tenant, occurrence.occurrence_id as ItemOccurrenceId);
  const source = new CaptureArtifactSource({ db, tenant, run_id: "run-1", collector: oakridgeEvidence, repository: createGitRepositoryReader() });
  const collected = await collectPinnedQuestion(db, tenant, source, pinned!);
  expect(collected).toMatchObject({ ok: true, value: { readiness: { state: "ready", references: expect.arrayContaining([
    expect.objectContaining({ ref: "citation:0", path: "docs/demo.png", is_binary: true, byte_size: PNG.byteLength, content: null })]) } } });
}));
