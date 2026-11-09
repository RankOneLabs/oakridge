import { describe, expect, test } from "vitest";
import type { AnswerRead, EvidenceReference, MeasurementState, Paged, StageComposite, SubmissionAcknowledgment } from "../grading-types";
import { compositeId } from "../adapters/core";
import { answerTone, itemSelectionKey, measurementDisplay, referenceDisplay, selectHumanForm, selectItemSelection, selectItemText, selectOwnCurrentAnswer, selectStageView, selectSubmissionNotice, stagePublicationLabel, taskLinkLabel } from "./grading";

const empty = <Item,>(): Paged<Item> => ({ items: [], total: 0, limit: 50, offset: 0 });
const answer = (observation_id: string, supersedes_observation_id: string | null = null): AnswerRead => ({ observation_id, execution_id: observation_id, occurrence_id: "o", evidence_set_id: "e",
  question: { question_id: "q", question_version: "1" }, evaluator_definition_id: "human", reviewer_id: "r", answer: { state: "answered", kind: "choice", value: "supports" },
  supersedes_observation_id, confidence: null, rationale: null, comments: null, recorded_at: "2026-11-01", grader: { kind: "human", evaluator_definition_id: "human", reviewer_id: "r" } });

describe("item selection", () => {
  const revision = compositeId({ kind: "artifact", runId: "run-1", unitId: "run-1/integration/final", name: "assessment:run-1/integration/final:assessment:3" });
  test("addresses a finding by the authority's exact revision and its path, with no task, cohort or stage", () => {
    expect(selectItemSelection({ revision_id: revision }, "/findings/2")).toEqual({ source_revision_id: "run-1/integration/final:assessment:3", item_path: "/findings/2" });
  });
  test("no revision identity means no address, rather than a guess", () => {
    expect(selectItemSelection(undefined, "/findings/0")).toBeNull();
    expect(selectItemSelection({ revision_id: "not-a-composite" }, "/findings/0")).toBeNull();
  });
  test("two paths of one revision are different items", () => {
    const at = (item_path: string) => itemSelectionKey({ source_revision_id: "r", item_path });
    expect(at("/findings/1")).not.toBe(at("/findings/10"));
  });
});

describe("states read apart", () => {
  const states: readonly MeasurementState[] = [{ state: "not_ready", code: "repository_unavailable", detail: "no clone" }, { state: "grading_off" }, { state: "awaiting_admission" },
    { state: "pending", status: "queued" }, { state: "budget_deferred" }, { state: "failed", terminal_cause: "retry_exhausted", error: "rate limited" },
    { state: "answered", observation_id: "o", answer: { state: "answered", kind: "choice", value: "contradicted" } }];
  test("every measurement state has its own label", () => {
    const labels = states.map((state) => measurementDisplay(state).label);
    expect(new Set(labels).size).toBe(states.length);
    expect(labels).toContain("contradicted");
  });
  test("not ready keeps its reason and a failure its error", () => {
    expect(measurementDisplay(states[0]!).detail).toContain("repository_unavailable");
    expect(measurementDisplay(states[5]!).detail).toBe("rate limited");
  });
  for (const value of ["irrelevant", "contradicted", "does_not_support", "unclear"]) test(`${value} is an answer, not failed or missing work`, () => {
    expect(answerTone(value)).not.toBe("danger");
    expect(answerTone(value)).not.toBe("muted");
    expect(measurementDisplay({ state: "answered", observation_id: "o", answer: { state: "answered", kind: "choice", value } }).tone).not.toBe("danger");
  });
});

describe("the human form", () => {
  test("opens with the question's exact choices", () => {
    expect(selectHumanForm({ state: "ready" }, ["supports", "does_not_support", "unclear"])).toEqual({ kind: "open", choices: ["supports", "does_not_support", "unclear"] });
  });
  test("a question not ready says why and offers no choice", () => {
    expect(selectHumanForm({ state: "not_ready", code: "build_result_unavailable", detail: "no build" }, ["supported"])).toEqual({ kind: "not_ready", code: "build_result_unavailable", detail: "no build" });
  });
  test("the current answer is the end of the reviewer's own correction chain", () => {
    expect(selectOwnCurrentAnswer([answer("a"), answer("b", "a"), answer("c", "b")])?.observation_id).toBe("c");
    expect(selectOwnCurrentAnswer([])).toBeNull();
  });
});

describe("saved means acknowledged", () => {
  const acknowledgment = { status: "recorded", answer: { state: "answered", kind: "choice", value: "does_not_support" } } as SubmissionAcknowledgment;
  test("pending, refused and failed never read as saved", () => {
    expect(selectSubmissionNotice({ is_pending: true, result: undefined }).kind).toBe("pending");
    expect(selectSubmissionNotice({ is_pending: true, result: { kind: "acknowledged", acknowledgment } }).kind).toBe("pending");
    expect(selectSubmissionNotice({ is_pending: false, result: { kind: "refused", code: "not_ready", message: "waiting" } })).toEqual({ kind: "refused", message: "waiting" });
    expect(selectSubmissionNotice({ is_pending: false, result: { kind: "failed", message: "lost" } })).toEqual({ kind: "failed", message: "lost" });
    expect(selectSubmissionNotice({ is_pending: false, result: undefined }).kind).toBe("none");
  });
  test("an acknowledgment says saved, and a duplicate is the original result", () => {
    expect(selectSubmissionNotice({ is_pending: false, result: { kind: "acknowledged", acknowledgment } })).toEqual({ kind: "saved", is_duplicate: false, answer: "does not support" });
    expect(selectSubmissionNotice({ is_pending: false, result: { kind: "acknowledged", acknowledgment: { ...acknowledgment, status: "duplicate" } } })).toMatchObject({ is_duplicate: true });
  });
});

describe("frozen references", () => {
  const fields = { ref: "citation:0", content: "x" };
  test("reported output is labelled agent-reported, and a missing file absent, with exact provenance", () => {
    const reported: EvidenceReference = { ...fields, source: "reported", reported_by: "agent", revision_id: "r", item_path: "/findings/0/evidence/1" };
    expect(referenceDisplay(reported)).toMatchObject({ is_agent_reported: true, source_label: "Agent-reported" });
    const absent: EvidenceReference = { ...fields, content: null, source: "repository", repository_key: "oakridge", commit_sha: "abc", path: "a.ts", line_range: { start: 2, end: 4 }, is_absent: true };
    expect(referenceDisplay(absent)).toEqual({ source_label: "Repository", location: "oakridge a.ts:2-4 @ abc", is_agent_reported: false, is_absent: true });
    expect(referenceDisplay({ ...fields, source: "run_input", run_id: "run-1", input_path: "/spec" })).toMatchObject({ source_label: "Launch input", location: "run-1 /spec" });
    expect(referenceDisplay({ ...fields, source: "revision", revision_id: "r", item_path: null })).toMatchObject({ location: "r" });
  });
});

describe("stages", () => {
  const stage = (overrides: Partial<StageComposite>): StageComposite => ({ stage: "integration", publication: { state: "pending" }, coverage: "gap", questions: empty(), answers: empty(), statuses: empty(), disagreements: empty(),
    totals: { contributing_items: 0, not_ready_items: 0, pending_items: 0, failed_items: 0, budget_deferred_items: 0, grading_off_items: 0, superseded_items: 0, superseded_answers: 0 },
    items: { logical_item_id: "t", stage: "integration", selector: { kind: "items" } }, history: { logical_item_id: "t", stage: "integration", selector: { kind: "history" } }, ...overrides });
  const published = (is_final: boolean): StageComposite["publication"] => ({ state: "published", is_final, unit_ids: empty() });
  test("integration is pending, then final results; another stage is only published", () => {
    expect(stagePublicationLabel(stage({}))).toBe("Pending");
    expect(stagePublicationLabel(stage({ publication: published(true) }))).toBe("Final results");
    expect(stagePublicationLabel(stage({ publication: published(false) }))).toBe("Published");
  });
  test("a hidden stage carries no answer, status or disagreement at all", () => {
    const count = { question: { question_id: "q", question_version: "1" }, grader: { kind: "human", evaluator_definition_id: "h", reviewer_id: "r" }, answer: { state: "answered", value: "supports" }, count: 3, drilldown: stage({}).items } as const;
    const full = stage({ answers: { ...empty(), items: [count], total: 1 }, publication: published(false), coverage: "linked" });
    const hidden = selectStageView(full, false);
    expect(Object.keys(hidden).sort()).toEqual(["contributing_items", "coverage", "kind", "publication", "stage"]);
    expect(JSON.stringify(hidden)).not.toContain("supports");
    expect(selectStageView(full, true)).toMatchObject({ kind: "revealed", answers: [count] });
  });
});

test("an item reads by its description, and says so when it has none", () => {
  expect(selectItemText({ description: "It fails" })).toBe("It fails");
  expect(selectItemText({ status: "met" })).toBe("No description recorded.");
});
test("an unresolved link says so", () => {
  expect(taskLinkLabel({ state: "unresolved", producer_local_id: "T9", unresolved_target_ref: "logical_item:task:T9", relation_id: "r", evidence_ref: "e" })).toBe("T9 (unresolved)");
  expect(taskLinkLabel({ state: "resolved", producer_local_id: "T1", logical_item_id: "l", relation_id: "r", evidence_ref: "e" })).toBe("T1");
});
