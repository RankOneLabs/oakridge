/**
 * What each retained runner actually sends a provider, through an injected transport: the
 * collector's frozen evidence keeps an absent file explicitly absent, and every exact commit,
 * path, line range, source revision and item path survives serialization. No real provider call.
 */
import { oakridgeGradingRegistry } from "../src/producers/oakridge/profile";
import { expect, test } from "bun:test";
import type { ArtifactRevisionId, EvidenceSetId, ItemOccurrenceId, RunId } from "../src/domain/identity";
import type { JsonValue } from "../src/domain/primitives";
import { machineGraders, configuredEvaluator, parseGradingDefinitions, type GraderEntry } from "../src/grading/configuration";
import type { EvidenceReference } from "../src/grading/evidence";
import type { QuestionDefinition } from "../src/grading/question";
import type { GradingContext } from "../src/grading/runner";
import type { CapturedRevision, CapturedSources, SourceArtifact } from "../src/ports/artifact-source";
import type { GradeRunner } from "../src/ports/grade-runner";
import { oakridgeEvidence } from "../src/producers/oakridge/evidence";
import { CORRECTNESS_ID, EVIDENCE_SUPPORT_ID } from "../src/producers/oakridge/evidence";
import { OAKRIDGE_QUESTIONS, committedDefinitions } from "./grading-fixture";
import { createFastinoGlideRunner } from "../src/runners/fastino-glide";
import { createJevDirectRunner } from "../src/runners/jev-direct";
import { createLlmJudgeRunner } from "../src/runners/llm-judge";

const HEAD = "2222222222222222222222222222222222222222";
const reportedTests = { passed: 3, failed: 1, output: null, summary: null, cargo_test_output: "test result: FAILED. 3 passed; 1 failed" };
const artifact: SourceArtifact = { occurrence_id: "occurrence" as ItemOccurrenceId, run_id: "run-1" as RunId, revision_id: "assessment-1" as ArtifactRevisionId,
  item_path: "/findings/2", item_kind: "assessment_finding", selected_value: { task_ids: ["T1"], status: "met", evidence: [
    { kind: "file", ref: "core/decision-record.ts:2-3" }, { kind: "file", ref: "core/gone.ts" }, { kind: "test", ref: "decision_record::reads" }] } };
const sources: CapturedSources = {
  readRunInput: async () => ({ spec: "s", repositories: [{ key: "primary", preparation: { repository_path: "/repos/primary" } },
    { key: "other", preparation: { repository_path: "/repos/other" } }] }),
  readRevision: async (revision_id): Promise<CapturedRevision | null> => revision_id === "assessment-1"
    ? { revision_id: revision_id as ArtifactRevisionId, stage: "implementation", artifact_kind: "assessment", subject_id: "build-1", body: { head_sha: HEAD, test_evidence: reportedTests } }
    : revision_id === "build-1" ? { revision_id: revision_id as ArtifactRevisionId, stage: "implementation", artifact_kind: "build_result", subject_id: null, body: { head_sha: HEAD } } : null,
  readRevisionAt: async () => null, readLogicalItemAt: async () => ({ revision_id: "tasks-1" as ArtifactRevisionId, item_path: "/tasks/0", item_kind: "task", selected_value: { id: "T7" } }), readLinkedItems: async () => [],
  repository: { hasCommit: async (path) => path === "/repos/other",
    readFile: async ({ path }) => path === "core/gone.ts" ? { state: "absent" } : { state: "present", content: "one\ntwo\nthree\nfour" } },
};

const questionOf = (question_id: string): QuestionDefinition => OAKRIDGE_QUESTIONS.find((question) => question.question_id === question_id)!;

async function frozen(question: QuestionDefinition): Promise<readonly EvidenceReference[]> {
  const collected = await oakridgeEvidence.collect(artifact, { ...question, task_id: "task-7" as import("../src/domain/identity").LogicalItemId }, sources);
  if (collected.state !== "ready") throw new Error(JSON.stringify(collected));
  return collected.references;
}
/** The committed grading-definitions.json grader for the question, optionally moved to another retained runner. */
async function configured(question: QuestionDefinition, change: (grader: GraderEntry) => GraderEntry = (grader) => grader) {
  const parsed = parseGradingDefinitions(await committedDefinitions(), oakridgeGradingRegistry);
  if (!parsed.ok) throw new Error(parsed.error.detail);
  const grader = machineGraders(parsed.value.find((entry) => entry.id === question.question_id)!)[0]!;
  const evaluator = configuredEvaluator(question, change(grader));
  if (!evaluator.ok) throw new Error(evaluator.error.detail);
  return evaluator.value;
}
async function context(question: QuestionDefinition, change?: (grader: GraderEntry) => GraderEntry): Promise<GradingContext> {
  return { question, evaluator: await configured(question, change),
    evidence: { evidence_set_id: "evidence-1" as EvidenceSetId, references: await frozen(question), is_incomplete: false, incompleteness_reason: null } };
}

type Sent = Record<string, JsonValue>;
/** The labelled evidence a provider received, from whichever request shape its runner sends. */
async function sentEvidence(runner: (transport: (url: string, init: RequestInit) => Promise<Response>) => GradeRunner,
  grading: GradingContext): Promise<Record<string, Sent>> {
  let body: { state?: Record<string, Sent>; messages?: { content: string }[] } | null = null;
  await runner(async (_url, init) => { body = JSON.parse(String(init.body)); return new Response("{}", { status: 500 }); }).run(grading);
  const sent = body as { state?: Record<string, Sent>; messages?: { content: string }[] } | null;
  if (sent?.state) return sent.state;
  const prompt = JSON.parse(sent!.messages![0]!.content) as { evidence: string };
  return Object.fromEntries((JSON.parse(prompt.evidence) as (Sent & { ref: string })[]).map(({ ref, ...rest }) => [ref, rest]));
}

const expectedEvidence = {
  "task_context:0": { source: "revision", revision_id: "tasks-1", item_path: "/tasks/0", content: { id: "T7" } },
  subject: { source: "revision", revision_id: "assessment-1", item_path: "/findings/2", content: artifact.selected_value },
  "citation:0": { source: "repository", repository_key: "other", commit_sha: HEAD, path: "core/decision-record.ts",
    line_range: { start: 2, end: 3 }, is_absent: false, content: "two\nthree" },
  "citation:1": { source: "repository", repository_key: "other", commit_sha: HEAD, path: "core/gone.ts",
    line_range: null, is_absent: true, content: null },
  "citation:2": { source: "reported", reported_by: "agent", revision_id: "assessment-1", item_path: "/findings/2/evidence/2",
    content: { kind: "test", citation: "decision_record::reads", detail: null } },
  test_evidence: { source: "reported", reported_by: "agent", revision_id: "assessment-1", item_path: "/test_evidence", content: reportedTests },
};

const transports = {
  jev_direct: (transport: (url: string, init: RequestInit) => Promise<Response>) =>
    createJevDirectRunner({ api_key: "key", base_url: "https://jev.invalid/v1", transport }),
  fastino_glide: (transport: (url: string, init: RequestInit) => Promise<Response>) =>
    createFastinoGlideRunner({ api_key: "key", base_url: "https://glide.invalid/v1", transport }),
  llm_judge: (transport: (url: string, init: RequestInit) => Promise<Response>) =>
    createLlmJudgeRunner({ api_key: "key", base_url: "https://judge.invalid/v1", transport }),
} as const;
/** Each runner gets instructions in its own shape; the System One runners use grading-definitions.json's as committed. */
const asRunner = (runner: keyof typeof transports) => (grader: GraderEntry): GraderEntry => runner === "llm_judge"
  ? { ...grader, runner, instructions: { rubric: "Does the cited evidence support the finding?", max_evidence_chars: 32_000 } }
  : { ...grader, runner };

for (const runner of Object.keys(transports) as (keyof typeof transports)[]) {
  test(`${runner} sends Evidence support every reference with its provenance, and an absent file as absent`, async () => {
    const sent = await sentEvidence(transports[runner], await context(questionOf(EVIDENCE_SUPPORT_ID), asRunner(runner)));
    expect(sent).toEqual(expectedEvidence);
  });
}

test("Correctness also sends the exact build it assessed, as a revision", async () => {
  const sent = await sentEvidence(transports.jev_direct, await context(questionOf(CORRECTNESS_ID)));
  expect(sent).toEqual({ ...expectedEvidence, build_result: { source: "revision", revision_id: "build-1", item_path: null, content: { head_sha: HEAD } } });
});

test("grading-definitions.json instructions describe the request the System One runners send", async () => {
  const parsed = parseGradingDefinitions(await committedDefinitions(), oakridgeGradingRegistry);
  if (!parsed.ok) throw new Error(parsed.error.detail);
  for (const entry of parsed.value) for (const grader of machineGraders(entry)) {
    const text = (grader.instructions as { system_one: { instructions: string } }).system_one.instructions;
    const labels = entry.id === "finding.relevance" ? ["state.subject", "state.spec"]
      : entry.id === "task.requirement_coverage" ? ["state.subject", "state.spec_task", "state.spec", "state.requirement:N"]
      : entry.id === "acceptance_entry.task_coverage" ? ["state.subject", "state.spec_task", "state.plan", "state.contribution_context"]
      : ["state.subject", "citation:N", "test_evidence", "is_absent", "commit_sha", "line_range", "reported"];
    for (const label of ["source", "content", ...labels]) expect(text).toContain(label);
  }
});
