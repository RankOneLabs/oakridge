import { expect, test } from "bun:test";
import type { ItemOccurrenceId, QuestionId } from "../src/domain/identity";
import type { JsonValue } from "../src/domain/primitives";
import type { EvidenceReference } from "../src/grading/evidence";
import type { CapturedRevision, CapturedSources, LinkedItem, RepositoryFile, SourceArtifact } from "../src/ports/artifact-source";
import { citationsOf, oakridgeEvidence, parseFileCitation } from "../src/producers/oakridge/evidence";
import { CORRECTNESS_ID, EVIDENCE_SUPPORT_ID, OAKRIDGE_QUESTIONS, RELEVANCE_ID } from "../src/producers/oakridge/questions";
import { CaptureArtifactSource } from "../src/storage/capture-artifact-source";
import { readOccurrenceEvidence, collectPinnedQuestion } from "../src/storage/captured-evidence-store";
import { registerEvaluator, registerQuestion } from "../src/storage/grading-store";
import { listRunItems } from "../src/storage/projection-store";
import { createFeed, evaluator, evaluatorId, fixtureBody, integration, occurrenceIdOf, scratchDatabase, tenant } from "./grading-fixture";

const HEAD = "1111111111111111111111111111111111111111";
const launch = { spec: "The whole spec", repositories: [
  { key: "other", preparation: { repository_path: "/repos/other" } },
  { key: "oakridge", preparation: { repository_path: "/repos/oakridge" } }] };
const finding = (evidence: JsonValue): SourceArtifact => ({ occurrence_id: "occurrence" as ItemOccurrenceId, run_id: "run-1", revision_id: "assessment-1",
  item_path: "/findings/0", item_kind: "assessment_finding", selected_value: { task_ids: [], evidence } });
interface SourceOptions {
  readonly input?: JsonValue | null;
  readonly subject_id?: string | null;
  readonly build?: CapturedRevision | null;
  readonly file?: RepositoryFile;
  readonly commit_in?: string | null;
  readonly linked?: readonly LinkedItem[];
  readonly assessment?: JsonValue;
}
const build: CapturedRevision = { revision_id: "build-1", artifact_kind: "build_result", subject_id: null, body: { head_sha: HEAD } };
function sources(options: SourceOptions = {}): CapturedSources & { readonly paths: readonly string[] } {
  const paths: string[] = [];
  return { paths, readRunInput: async () => options.input === undefined ? launch : options.input,
    readRevision: async (revision_id) => revision_id === "assessment-1"
      ? { revision_id, artifact_kind: "assessment", subject_id: options.subject_id ?? null, body: options.assessment ?? { head_sha: HEAD } }
      : revision_id === "build-1" ? options.build === undefined ? build : options.build : null,
    readLinkedItems: async () => options.linked ?? [],
    repository: { hasCommit: async (path) => path === (options.commit_in === undefined ? "/repos/oakridge" : options.commit_in),
      readFile: async (request) => { paths.push(`${request.repository_path}@${request.commit_sha}:${request.path}`);
        return options.file ?? { state: "present", content: "one\ntwo\nthree\nfour" }; } } };
}
const key = (question_id: QuestionId) => ({ question_id, question_version: "1" });

test("the supported questions are exactly three, with their item kinds and answers", () => {
  expect(OAKRIDGE_QUESTIONS.map(({ question_id, item_kind, allowed_values }) => [question_id, item_kind, allowed_values])).toEqual([
    [RELEVANCE_ID, "finding", ["relevant", "irrelevant", "unclear"]],
    [CORRECTNESS_ID, "assessment_finding", ["supported", "contradicted", "unclear"]],
    [EVIDENCE_SUPPORT_ID, "assessment_finding", ["supports", "does_not_support", "unclear"]]]);
});

test("a file citation is a path with optional lines; anything else stays text", () => {
  expect(parseFileCitation("core/decision-record.ts:18-31")).toEqual({ path: "core/decision-record.ts", line_range: { start: 18, end: 31 } });
  expect(parseFileCitation("core/decision-record.ts:18")).toEqual({ path: "core/decision-record.ts", line_range: { start: 18, end: 18 } });
  expect(parseFileCitation("core/decision-record.ts")).toEqual({ path: "core/decision-record.ts", line_range: null });
  expect(parseFileCitation("see the design doc")).toBeNull();
  expect(parseFileCitation("file.ts:31-18")).toBeNull();
});

test("relevance needs the captured spec and records where it came from", async () => {
  const artifact = { ...finding([]), item_kind: "finding", item_path: "/findings/1", revision_id: "analysis-1" };
  expect(await oakridgeEvidence.collect(artifact, key(RELEVANCE_ID), sources({ input: null })))
    .toMatchObject({ state: "not_ready", reason: { code: "spec_unavailable" } });
  const ready = await oakridgeEvidence.collect(artifact, key(RELEVANCE_ID), sources());
  expect(ready).toMatchObject({ state: "ready", references: [
    { source: "revision", ref: "subject", revision_id: "analysis-1", item_path: "/findings/1" },
    { source: "run_input", ref: "spec", run_id: "run-1", input_path: "/spec", content: "The whole spec" }] });
});

test("correctness waiting on its subject does not hold evidence support back", async () => {
  const waiting = sources({ subject_id: "build-1", build: null });
  const artifact = finding([{ kind: "test", ref: "alpha.test.ts" }]);
  expect(await oakridgeEvidence.collect(artifact, key(CORRECTNESS_ID), waiting))
    .toMatchObject({ state: "not_ready", reason: { code: "build_result_unavailable", detail: "build result build-1 is not captured" } });
  expect(await oakridgeEvidence.collect(artifact, key(EVIDENCE_SUPPORT_ID), waiting)).toMatchObject({ state: "ready" });
});

test("an integration finding with no subject is ready for correctness", async () => {
  const result = await oakridgeEvidence.collect(finding([]), key(CORRECTNESS_ID), sources());
  expect(result).toMatchObject({ state: "ready" });
  expect(result.state === "ready" && result.references.map((reference) => reference.ref)).toEqual(["subject"]);
});

test("correctness names the exact build and optional linked context", async () => {
  const linked: readonly LinkedItem[] = [{ revision_id: "plan-1", item_path: "/cohorts/0/acceptance_criteria/0", item_kind: "acceptance_entry", selected_value: { id: "T7" } }];
  const result = await oakridgeEvidence.collect(finding([]), key(CORRECTNESS_ID), sources({ subject_id: "build-1", linked }));
  expect(result).toMatchObject({ state: "ready", references: [{ ref: "subject" },
    { source: "revision", ref: "build_result", revision_id: "build-1", item_path: null, content: { head_sha: HEAD } },
    { source: "revision", ref: "task_context:0", revision_id: "plan-1", item_path: "/cohorts/0/acceptance_criteria/0" }] });
});

test("a file is read at head_sha from the repository holding it, keeping its range", async () => {
  const source = sources();
  const result = await oakridgeEvidence.collect(finding([{ kind: "file", ref: "src/alpha.ts:2-3" }]), key(EVIDENCE_SUPPORT_ID), source);
  expect(source.paths).toEqual([`/repos/oakridge@${HEAD}:src/alpha.ts`]);
  expect(result).toMatchObject({ state: "ready", references: [{ ref: "subject" }, { source: "repository", ref: "citation:0", repository_key: "oakridge",
    commit_sha: HEAD, path: "src/alpha.ts", line_range: { start: 2, end: 3 }, is_absent: false, content: "two\nthree" }] });
});

test("a file missing at an accessible commit is evidence; an unreadable repository waits", async () => {
  const cited = finding([{ kind: "file", ref: "src/gone.ts" }]);
  expect(await oakridgeEvidence.collect(cited, key(EVIDENCE_SUPPORT_ID), sources({ file: { state: "absent" } })))
    .toMatchObject({ state: "ready", references: [{ ref: "subject" }, { source: "repository", path: "src/gone.ts", is_absent: true, content: null }] });
  expect(await oakridgeEvidence.collect(cited, key(EVIDENCE_SUPPORT_ID), sources({ commit_in: null })))
    .toMatchObject({ state: "not_ready", reason: { code: "repository_unavailable" } });
  expect(await oakridgeEvidence.collect(cited, key(EVIDENCE_SUPPORT_ID), sources({ file: { state: "unavailable", detail: "git failed" } })))
    .toMatchObject({ state: "not_ready", reason: { code: "repository_unavailable", detail: "git failed" } });
});

test("unparseable refs stay text, test and output stay agent-reported, and empty citations are ready", async () => {
  const source = sources({ commit_in: null });
  const cited = finding([{ kind: "file", ref: "the design doc" }, { kind: "test", ref: "alpha.test.ts", detail: "1 passed" }, { kind: "output", ref: "bun test" }]);
  expect(citationsOf(cited.selected_value)).toHaveLength(3);
  expect(await oakridgeEvidence.collect(cited, key(EVIDENCE_SUPPORT_ID), source)).toMatchObject({ state: "ready", references: [{ ref: "subject" },
    { source: "reported", reported_by: "agent", revision_id: "assessment-1", item_path: "/findings/0/evidence/0", content: { kind: "file", citation: "the design doc" } },
    { source: "reported", reported_by: "agent", revision_id: "assessment-1", item_path: "/findings/0/evidence/1", content: { kind: "test", citation: "alpha.test.ts", detail: "1 passed" } },
    { source: "reported", reported_by: "agent", revision_id: "assessment-1", item_path: "/findings/0/evidence/2", content: { kind: "output", citation: "bun test" } }] });
  expect(await oakridgeEvidence.collect(finding([]), key(EVIDENCE_SUPPORT_ID), source)).toMatchObject({ state: "ready" });
});

const reportedTests = { passed: 41, failed: 1, output: "1 failed", summary: "core suite",
  cargo_test_output: "test decision_record::reads ... FAILED\ntest result: FAILED. 41 passed; 1 failed" };

test("the assessment's test results, cargo output included, are shared agent-reported evidence for both questions", async () => {
  // An integration assessment: no build subject, and no task linked to the finding.
  const source = sources({ assessment: { head_sha: HEAD, test_evidence: reportedTests } });
  const cited = finding([{ kind: "file", ref: "src/alpha.ts:2" }]);
  const expected: EvidenceReference = { source: "reported", reported_by: "agent", ref: "test_evidence", revision_id: "assessment-1", item_path: "/test_evidence",
    content: reportedTests };
  const correctness = await oakridgeEvidence.collect(cited, key(CORRECTNESS_ID), source);
  const support = await oakridgeEvidence.collect(cited, key(EVIDENCE_SUPPORT_ID), source);
  for (const result of [correctness, support]) {
    expect(result.state).toBe("ready");
    expect(result.state === "ready" && result.references.map((reference) => reference.ref)).toEqual(["subject", "citation:0", "test_evidence"]);
    expect(result.state === "ready" && result.references.at(-1)).toEqual(expected);
  }
});

test("test results reported without a file citation are kept, and an assessment without them is still ready", async () => {
  const reportedOnly = await oakridgeEvidence.collect(finding([{ kind: "output", ref: "cargo test" }]), key(EVIDENCE_SUPPORT_ID),
    sources({ commit_in: null, assessment: { head_sha: HEAD, test_evidence: reportedTests } }));
  expect(reportedOnly).toMatchObject({ state: "ready", references: [{ ref: "subject" },
    { source: "reported", ref: "citation:0", item_path: "/findings/0/evidence/0" }, { source: "reported", ref: "test_evidence", content: reportedTests }] });
  const none = await oakridgeEvidence.collect(finding([]), key(CORRECTNESS_ID), sources({ assessment: { head_sha: HEAD, test_evidence: null } }));
  expect(none.state === "ready" && none.references.map((reference) => reference.ref)).toEqual(["subject"]);
});

test("a citation keeps its own position in the finding when an earlier entry is malformed", async () => {
  const result = await oakridgeEvidence.collect(finding([{ kind: "screenshot", ref: "x" }, { kind: "test", ref: "alpha.test.ts" }]),
    key(EVIDENCE_SUPPORT_ID), sources());
  expect(result).toMatchObject({ state: "ready", references: [{ ref: "subject" }, { ref: "citation:0", item_path: "/findings/0/evidence/1" }] });
});

test("a question outside the profile is reported rather than collected", async () => {
  expect(await oakridgeEvidence.collect(finding([]), key("unknown" as QuestionId), sources()))
    .toMatchObject({ state: "not_ready", reason: { code: "unsupported_question" } });
});

integration("captured sources feed the collector within one run, and collection freezes per question", async () => scratchDatabase(async (db) => {
  for (const question of OAKRIDGE_QUESTIONS) await registerQuestion(db, tenant, question);
  await registerEvaluator(db, tenant, evaluator("human"));
  const configuration = { pins: OAKRIDGE_QUESTIONS.map((question) => ({ ...question, evaluator_definition_ids: [evaluatorId("human")] })) };
  const feed = createFeed(db, tenant, configuration);
  await feed.launch(launch);
  await feed.revision({ revision_id: "tasks-1", artifact_kind: "tasks", body: await fixtureBody("tasks") });
  await feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", subject_id: "build-1", body: await fixtureBody("assessment") });
  const page = await listRunItems(db, tenant, "run-1", { limit: 200, offset: 0 });
  const subject = page.items.find((item) => item.json_pointer === "/findings/1" && item.item_kind === "assessment_finding")!;
  const repository = { hasCommit: async () => true, readFile: async () => ({ state: "absent" as const }) };
  const source = new CaptureArtifactSource({ db, tenant, run_id: "run-1", collector: oakridgeEvidence, repository });
  const [correctness, support] = await readOccurrenceEvidence(db, tenant, occurrenceIdOf(subject.occurrence_id));
  const waiting = await collectPinnedQuestion(db, tenant, source, correctness!);
  expect(waiting.ok && waiting.value.readiness).toMatchObject({ state: "not_ready", reason: { code: "build_result_unavailable" } });
  const ready = await collectPinnedQuestion(db, tenant, source, support!);
  expect(ready.ok && ready.value.readiness).toMatchObject({ state: "ready", references: [{ source: "revision", ref: "subject", revision_id: "assessment-1", item_path: "/findings/1" }] });
  await feed.revision({ revision_id: "build-1", artifact_kind: "build_result", body: await fixtureBody("build-result") });
  const retried = await collectPinnedQuestion(db, tenant, source, correctness!);
  expect(retried.ok && retried.value.readiness).toMatchObject({ state: "ready", references: [{ ref: "subject" }, { ref: "build_result", revision_id: "build-1" },
    { source: "revision", ref: "task_context:0", revision_id: "tasks-1", item_path: "/tasks/0" }] });
  const elsewhere = new CaptureArtifactSource({ db, tenant, run_id: "run-2", collector: oakridgeEvidence, repository });
  expect(await elsewhere.read(occurrenceIdOf(subject.occurrence_id))).toBeNull();
  expect(await elsewhere.readRevision("assessment-1")).toBeNull();
}));
