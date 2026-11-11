import { describe, expect, test } from "vitest";
import type { ObservationJsonValue } from "../grading-contracts/domain/primitives";
import type { ObservationGradeObservationId, ObservationReviewerId } from "../grading-contracts/domain/identity";
import type { ObservationAnswerCount, ObservationPaged } from "../grading-contracts/grading/composite";
import type { ObservationEvidenceReference } from "../grading-contracts/grading/evidence";
import type { ObservationMeasurementState } from "../grading-contracts/grading/execution";
import type { ObservationAnswerRead, ObservationStageCompositeRead } from "../grading-contracts/grading/item-reads";
import type { ObservationHumanSubmissionAcknowledgment } from "../grading-contracts/http/grades";
import type { ObservationQuestionStatusResponse } from "../grading-contracts/storage/grading-record-store";
import { id, itemStatus, machine, paged, reviewerAnswer, supportQuestion } from "../__fixtures__/grading";
import { compositeId } from "../adapters/core";
import { answerTone, EMPTY_GRADE_DRAFT, gradeActionLabel, isStaleAnswerRefusal, selectEarlierOwnAnswers, selectGradeEditor, itemSelectionKey, selectAutomaticGlances, selectFindingSelections, selectOwnGradeProgress, measurementDisplay, referenceDisplay, selectHumanForm, selectItemSelection, selectItemHeader, selectItemText, selectOwnCurrentAnswer, selectStageView, selectSubmissionNotice, stagePublicationLabel, taskLinkLabel } from "./grading";

const empty = <Item,>(): ObservationPaged<Item> => ({ items: [], total: 0, limit: 50, offset: 0 });
const answer = (observation_id: string, supersedes_observation_id: string | null = null): ObservationAnswerRead => ({ observation_id: id(observation_id), execution_id: id(observation_id), occurrence_id: id("o"), evidence_set_id: id("e"),
  question: { question_id: id("q"), question_version: "1" }, evaluator_definition_id: id("human"), reviewer_id: id<ObservationReviewerId>("r"), answer: { state: "answered", kind: "choice", value: "supports" },
  supersedes_observation_id: supersedes_observation_id === null ? null : id<ObservationGradeObservationId>(supersedes_observation_id), confidence: null, rationale: null, comments: null, recorded_at: "2026-11-01", grader: { kind: "human", evaluator_definition_id: id("human"), reviewer_id: id("r") }, is_current: true });

describe("item selection", () => {
  const revision = compositeId({ kind: "artifact", runId: "run-1", unitId: "run-1/integration/final", name: "assessment:run-1/integration/final:assessment:3" });
  test("addresses a finding by the authority's exact revision and its path, with no task, cohort or stage", () => {
    expect(selectItemSelection({ revision_id: revision }, "/findings/2")).toEqual({ source_revision_id: id("run-1/integration/final:assessment:3"), item_path: "/findings/2" });
  });
  test("no revision identity means no address, rather than a guess", () => {
    expect(selectItemSelection(undefined, "/findings/0")).toBeNull();
    expect(selectItemSelection({ revision_id: id("not-a-composite") }, "/findings/0")).toBeNull();
  });
  test("two paths of one revision are different items", () => {
    const at = (item_path: string) => itemSelectionKey({ source_revision_id: id("r"), item_path });
    expect(at("/findings/1")).not.toBe(at("/findings/10"));
  });
});

describe("states read apart", () => {
  const states: readonly ObservationMeasurementState[] = [{ state: "not_ready", code: "repository_unavailable", detail: "no clone" }, { state: "grading_off" }, { state: "awaiting_admission" },
    { state: "pending", status: "queued" }, { state: "budget_deferred" }, { state: "failed", terminal_cause: "retry_exhausted", error: "rate limited" },
    { state: "answered", observation_id: id("o"), answer: { state: "answered", kind: "choice", value: "contradicted" } }];
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
    expect(measurementDisplay({ state: "answered", observation_id: id("o"), answer: { state: "answered", kind: "choice", value } }).tone).not.toBe("danger");
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

describe("the operator's grade editor", () => {
  const current = reviewerAnswer("now", "supports", "oakridge-operator", { rationale: "cited line 4" });
  test("starts from the current answer's choice and explanation, unchanged", () => {
    expect(selectGradeEditor(current, EMPTY_GRADE_DRAFT)).toEqual({ choice: "supports", rationale: "cited line 4", is_changed: false });
  });
  test("a new explanation alone is a correction", () => {
    expect(selectGradeEditor(current, { choice: null, rationale: "cited line 5" }).is_changed).toBe(true);
  });
  test("clearing the explanation is a correction, and whitespace counts as clear", () => {
    expect(selectGradeEditor(current, { choice: null, rationale: "  " }).is_changed).toBe(true);
    expect(selectGradeEditor({ ...current, rationale: null }, { choice: null, rationale: "  " }).is_changed).toBe(false);
  });
  test("picking the same choice again changes nothing", () => {
    expect(selectGradeEditor(current, { choice: "supports", rationale: null }).is_changed).toBe(false);
  });
  test("with no answer yet, nothing is saveable until a choice is picked", () => {
    expect(selectGradeEditor(null, { choice: null, rationale: "why" }).is_changed).toBe(false);
    expect(selectGradeEditor(null, { choice: "supports", rationale: null })).toEqual({ choice: "supports", rationale: "", is_changed: true });
  });
  test("earlier answers are every own answer but the current one", () => {
    const first = reviewerAnswer("first", "does_not_support");
    expect(selectEarlierOwnAnswers([first, current], current).map((answer) => answer.observation_id)).toEqual(["first"]);
    expect(selectEarlierOwnAnswers([], null)).toEqual([]);
  });
  test("only stale-correction refusals mean the form's own answers are out of date", () => {
    expect(isStaleAnswerRefusal({ kind: "refused", code: "stale_correction", message: "m" })).toBe(true);
    expect(isStaleAnswerRefusal({ kind: "refused", code: "correction_required", message: "m" })).toBe(true);
    expect(isStaleAnswerRefusal({ kind: "refused", code: "not_ready", message: "m" })).toBe(false);
    expect(isStaleAnswerRefusal({ kind: "failed", message: "m" })).toBe(false);
  });
});

describe("saved means acknowledged", () => {
  const acknowledgment = { status: "recorded", answer: { state: "answered", kind: "choice", value: "does_not_support" } } as ObservationHumanSubmissionAcknowledgment;
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
    const reported: ObservationEvidenceReference = { ...fields, source: "reported", reported_by: "agent", revision_id: id("r"), item_path: "/findings/0/evidence/1" };
    expect(referenceDisplay(reported)).toMatchObject({ is_agent_reported: true, source_label: "Agent-reported" });
    const absent: ObservationEvidenceReference = { ...fields, content: null, source: "repository", repository_key: "oakridge", commit_sha: "abc", path: "a.ts", line_range: { start: 2, end: 4 }, is_absent: true };
    expect(referenceDisplay(absent)).toEqual({ source_label: "Repository", location: "oakridge a.ts:2-4 @ abc", is_agent_reported: false, is_absent: true });
    expect(referenceDisplay({ ...fields, source: "run_input", run_id: id("run-1"), input_path: "/spec" })).toMatchObject({ source_label: "Launch input", location: "run-1 /spec" });
    expect(referenceDisplay({ ...fields, source: "revision", revision_id: id("r"), item_path: null })).toMatchObject({ location: "r" });
  });
});

describe("stages", () => {
  const stage = (overrides: Partial<ObservationStageCompositeRead>): ObservationStageCompositeRead => ({ stage: "integration", publication: { state: "pending" }, coverage: "gap", questions: empty(), answers: empty(), statuses: empty(), disagreements: empty(),
    totals: { contributing_items: 0, not_ready_items: 0, pending_items: 0, failed_items: 0, budget_deferred_items: 0, grading_off_items: 0, superseded_items: 0, superseded_answers: 0 },
    items: { logical_item_id: id("t"), stage: "integration", selector: { kind: "items" } }, history: { logical_item_id: id("t"), stage: "integration", selector: { kind: "history" } }, ...overrides });
  const published = (is_final: boolean): ObservationStageCompositeRead["publication"] => ({ state: "published", is_final, unit_ids: empty() });
  test("integration is pending, then final results; another stage is only published", () => {
    expect(stagePublicationLabel(stage({}))).toBe("Pending");
    expect(stagePublicationLabel(stage({ publication: published(true) }))).toBe("Final results");
    expect(stagePublicationLabel(stage({ publication: published(false) }))).toBe("Published");
  });
  test("a hidden stage carries no answer, status or disagreement at all", () => {
    const count: ObservationAnswerCount = { question: { question_id: id("q"), question_version: "1" }, grader: { kind: "human", evaluator_definition_id: id("h"), reviewer_id: id("r") }, answer: { state: "answered", value: "supports" }, count: 3, drilldown: stage({}).items };
    const full = stage({ answers: { ...empty(), items: [count], total: 1 }, publication: published(false), coverage: "linked" });
    const hidden = selectStageView(full, false);
    expect(Object.keys(hidden).sort()).toEqual(["contributing_items", "coverage", "kind", "publication", "stage"]);
    expect(JSON.stringify(hidden)).not.toContain("supports");
    expect(selectStageView(full, true)).toMatchObject({ kind: "revealed", answers: [count] });
  });
});

test("an item reads by its description, and says so when it has none", () => {
  expect(selectItemText({ description: "It fails" })).toBe("It fails");
  expect(selectItemText({ id: "T1", text: "The cohort's assigned share" })).toBe("The cohort's assigned share");
  expect(selectItemText({ status: "met" })).toBe("No description recorded.");
});
test("an unresolved link says so", () => {
  expect(taskLinkLabel({ state: "unresolved", producer_local_id: "T9", unresolved_target_ref: "logical_item:task:T9", relation_id: id("r"), evidence_ref: "e" })).toBe("T9 (unresolved)");
  expect(taskLinkLabel({ state: "resolved", producer_local_id: "T1", logical_item_id: id("l"), relation_id: id("r"), evidence_ref: "e" })).toBe("T1");
});

describe("artifact glances", () => {
  const ready = { state: "ready" } as const;
  const OPERATOR = id<ObservationReviewerId>("operator");
  const question = (question_id: string, overrides: Partial<ObservationQuestionStatusResponse> = {}): ObservationQuestionStatusResponse => ({ ...supportQuestion(), question: { ...supportQuestion().question, question_id: id(question_id) }, ...overrides });
  const own = (question_id: string) => reviewerAnswer(`own-${question_id}`, "supports", "operator", { question: { question_id: id(question_id), question_version: "1" } });
  test("Grade until every question the operator can answer has their answer, then Graded", () => {
    const partly = itemStatus([question("a", { answers: paged([own("a")]) }), question("b", { answers: paged([reviewerAnswer("x", "unclear", "someone-else")]) })]);
    const fully = itemStatus([question("a", { answers: paged([own("a")]) }), question("b", { answers: paged([own("b")]) })]);
    expect([selectOwnGradeProgress(partly, OPERATOR), gradeActionLabel(selectOwnGradeProgress(partly, OPERATOR))]).toEqual([{ kind: "open", answered: 1, total: 2 }, "Grade"]);
    expect([selectOwnGradeProgress(fully, OPERATOR), gradeActionLabel(selectOwnGradeProgress(fully, OPERATOR))]).toEqual([{ kind: "graded", total: 2 }, "Graded"]);
  });
  test("a question with no human evaluator is not waiting on the operator", () => {
    const status = itemStatus([question("a", { answers: paged([own("a")]), human: ready }), question("b", { human: { state: "no_human_evaluator" } })]);
    expect(gradeActionLabel(selectOwnGradeProgress(status, OPERATOR))).toBe("Graded");
  });
  test("one glyph per automatic evaluator and question, an actual negative answer apart from failed and waiting work", () => {
    const status = itemStatus([
      question("assessment_finding.evidence_support"),
      question("assessment_finding.correctness", { machine: paged([machine({ state: "failed", terminal_cause: null, error: "boom" }), machine({ state: "budget_deferred" }), machine({ state: "pending", status: "queued" })]) }),
    ]);
    expect(selectAutomaticGlances(status).map(({ glyph, label }) => [glyph, label])).toEqual([
      ["negative", "Evidence support: does not support"], ["failed", "Correctness: Failed"], ["budget_deferred", "Correctness: Budget deferred"], ["waiting", "Correctness: Pending"]]);
  });
  test("show all addresses exactly the findings each row addresses", () => {
    const source = { revision_id: compositeId({ kind: "artifact", runId: "run-1", unitId: "u", name: "assessment:u:assessment:2" }) };
    expect(selectFindingSelections(source, ["/findings/0", "/findings/1"])).toEqual([{ source_revision_id: id("u:assessment:2"), item_path: "/findings/0" }, { source_revision_id: id("u:assessment:2"), item_path: "/findings/1" }]);
    expect(selectFindingSelections(undefined, ["/findings/0"])).toEqual([]);
  });
  test("coverage grades distinguish full, partial and missing coverage from an unclear answer", () => {
    const status = itemStatus([question("task.requirement_coverage", { machine: paged(
      ["fully_covers", "partially_covers", "does_not_cover", "unclear"].map((value) => machine({ state: "answered", observation_id: id(`coverage-${value}`),
        answer: { state: "answered", kind: "choice", value } }))) })]);
    expect(selectAutomaticGlances(status).map(({ glyph, tone }) => [glyph, tone])).toEqual([
      ["affirmative", "success"], ["partial", "warning"], ["negative", "warning"], ["unclear", "neutral"]]);
  });
});

describe("item header fields", () => {
  test.each([
    { value: "", text: "" },
    { value: "  ", text: "  " },
    { value: { description: " Description ", text: "Other" }, text: " Description " },
    { value: { description: " \n", text: " Text " }, text: " Text " },
    { value: { description: false, text: "Text" }, text: "Text" },
  ])("header and row preserve the same captured prose: $value", ({ value, text }) => {
    expect(selectItemHeader(value)).toEqual({ kind: "text", text });
    expect(selectItemText(value)).toBe(text);
  });
  test.each(["Plain text", { description: "Description", text: "Other" }, { description: " ", text: "Text" }])("prefers captured prose", (value) => {
    expect(selectItemHeader(value)).toEqual({ kind: "text", text: typeof value === "string" ? value : value.description?.trim() ? value.description : value.text });
  });
  test("assessment finding without prose shows status and task ids", () => {
    expect(selectItemHeader({ status: "met", task_ids: ["T1"], evidence: [], description: null })).toEqual({ kind: "assessment_finding", status: "met", task_ids: ["T1"] });
  });
  const fieldValues: ObservationJsonValue[] = [{ commitSha: "abc123", files: ["a.ts"] }, { status: "met" }, null, [1, false]];
  test.each(fieldValues)("other captured values keep their fields", (value) => {
    expect(selectItemHeader(value)).toEqual({ kind: "fields", value });
  });
});
