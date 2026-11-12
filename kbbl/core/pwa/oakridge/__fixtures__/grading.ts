// One run's observation reads, in the exact wire shape kbbl forwards. Answers from others are distinctive
// strings so a hidden-mode test can search the whole document for them.
import type { ObservationEvaluatorDefinitionId, ObservationExecutionId, ObservationItemOccurrenceId, ObservationReviewerId } from "../grading-contracts/domain/identity";
import type { ObservationAnswerCount, ObservationDisagreementCount, ObservationPaged, ObservationStatusCount } from "../grading-contracts/grading/composite";
import type { ObservationMeasurementState } from "../grading-contracts/grading/execution";
import type { ObservationAddressedItem, ObservationAnswerRead, ObservationCompositeRead, ObservationGradeableItemRow, ObservationItemAddress, ObservationStageCompositeRead } from "../grading-contracts/grading/item-reads";
import type { ObservationHumanSubmissionAcknowledgment } from "../grading-contracts/http/grades";
import type { ObservationAttemptRead } from "../grading-contracts/storage/execution-store";
import type { ObservationItemStatusResponse, ObservationMachineStatusResponse, ObservationQuestionStatusResponse } from "../grading-contracts/storage/grading-record-store";

/** A fixture id: the text a response would carry, typed as the identity its field names. */
export const id = <Id extends string>(raw: string): Id => raw as Id;

export const paged = <Item,>(items: readonly Item[], total: number = items.length, limit = 50, offset = 0): ObservationPaged<Item> => ({ items, total, limit, offset });

export const OCCURRENCE = id<ObservationItemOccurrenceId>("canonical-json/v1:occurrence");
export const IMPLEMENTATION: ObservationItemAddress = { source_revision_id: id("run-1/implementation/one:assessment:2"), item_path: "/findings/1" };
export const ANALYSIS: ObservationItemAddress = { source_revision_id: id("run-1/analysis:analysis:1"), item_path: "/findings/0" };
export const INTEGRATION: ObservationItemAddress = { source_revision_id: id("run-1/integration/final:assessment:1"), item_path: "/findings/0" };

export const item = (selection: ObservationItemAddress, overrides: Partial<ObservationAddressedItem> = {}): ObservationAddressedItem => ({ ...selection, occurrence_id: OCCURRENCE, revision_id: selection.source_revision_id,
  artifact_kind: "assessment", item_kind: "assessment_finding", selected_value: { description: "the narrow finding", status: "met" }, stage: "implementation", unit_id: id("run-1/implementation/one"), is_current: true, ...overrides });

export const machineAnswer = (value: string): ObservationAnswerRead => ({ task_id: null, observation_id: id(`machine-${value}`), execution_id: id(`execution-${value}`), occurrence_id: OCCURRENCE, evidence_set_id: id("evidence-support"),
  question: { question_id: id("assessment_finding.evidence_support"), question_version: "1" }, evaluator_definition_id: id("jev"), reviewer_id: null, answer: { state: "answered", kind: "choice", value },
  supersedes_observation_id: null, confidence: null, rationale: "machine rationale leak-marker", comments: null, recorded_at: "2026-11-01T00:00:00Z",
  grader: { kind: "machine", evaluator_definition_id: id("jev"), backend_kind: "jev_direct", model: "jev-1.14.0" }, is_current: true });
export const reviewerAnswer = (observation_id: string, value: string, reviewer_id = "oakridge-operator", extra: Partial<ObservationAnswerRead> = {}): ObservationAnswerRead => ({ ...machineAnswer(value), observation_id: id(observation_id), execution_id: id(`execution-${observation_id}`),
  evaluator_definition_id: id("human"), reviewer_id: id<ObservationReviewerId>(reviewer_id), rationale: null, grader: { kind: "human", evaluator_definition_id: id("human"), reviewer_id: id(reviewer_id) }, ...extra });

const attempt: ObservationAttemptRead = { attempt: 1, request_sent: true, outcome: "completed", failure_category: null, charged_cost: 0.01, admitted_estimate: 0.01, provider_request_id: "request-1" };
export const machine = (measurement: ObservationMeasurementState, overrides: Partial<ObservationMachineStatusResponse> = {}): ObservationMachineStatusResponse => ({ evaluator_definition_id: id(`jev-${measurement.state}`), backend_kind: "jev_direct", model: "jev-1.14.0",
  execution_id: id<ObservationExecutionId>("execution-1"), measurement, attempts: paged([attempt]), ...overrides });

export const supportQuestion = (overrides: Partial<ObservationQuestionStatusResponse> = {}): ObservationQuestionStatusResponse => ({ task_id: null,
  question: { question_id: id("assessment_finding.evidence_support"), question_version: "1", item_kind: "assessment_finding", question_text: "Does the cited evidence support it?", response_kind: "choice",
    allowed_values: ["supports", "does_not_support", "unclear"], missing_evidence_policy: "abstain", abstain_semantics: "", interpretation_caveats: "Judge only the citations.", unclear_semantics: "" },
  evidence: { task_id: null, question_id: id("assessment_finding.evidence_support"), question_version: "1", evidence_set_id: id("evidence-support"), subject_occurrence_id: OCCURRENCE, pinned_evaluator_definition_ids: paged([id("jev"), id("human")]),
    readiness: { state: "ready", ready_at: "2026-11-01T00:00:00Z" }, is_incomplete: false, incompleteness_reason: null,
    references: paged([{ source: "repository", ref: "citation:0", repository_key: "oakridge", commit_sha: "abc123", path: "src/a.ts", line_range: { start: 2, end: 3 }, is_absent: false, content: "cited code" },
      { source: "reported", reported_by: "agent", ref: "citation:1", revision_id: id("r"), item_path: "/findings/1/evidence/1", content: "reported output" }]) },
  human: { state: "ready" },
  machine: paged([machine({ state: "answered", observation_id: id("machine-does_not_support"), answer: { state: "answered", kind: "choice", value: "does_not_support" } })]),
  answers: paged([machineAnswer("does_not_support"), reviewerAnswer("other-reviewer", "unclear", "second-reviewer")]),
  superseded_answers: paged([]),
  ...overrides,
});
export const correctnessQuestion = (overrides: Partial<ObservationQuestionStatusResponse> = {}): ObservationQuestionStatusResponse => supportQuestion({
  question: { question_id: id("assessment_finding.correctness"), question_version: "1", item_kind: "assessment_finding", question_text: "Is this finding correct?", response_kind: "choice",
    allowed_values: ["supported", "contradicted", "unclear"], missing_evidence_policy: "abstain", abstain_semantics: "", interpretation_caveats: "Judge this one finding.", unclear_semantics: "" },
  human: { state: "not_ready", code: "build_result_unavailable", detail: "the build result is not captured yet" },
  evidence: { ...supportQuestion().evidence, question_id: id("assessment_finding.correctness"), evidence_set_id: id("evidence-correctness"), readiness: { state: "not_ready", reason: { code: "build_result_unavailable", detail: "the build result is not captured yet" } }, references: paged([]) },
  machine: paged([machine({ state: "not_ready", code: "build_result_unavailable", detail: "the build result is not captured yet" })]), answers: paged([]), ...overrides });

export const itemStatus = (questions: readonly ObservationQuestionStatusResponse[], overrides: Partial<ObservationItemStatusResponse> = {}, selection: ObservationItemAddress = IMPLEMENTATION): ObservationItemStatusResponse => ({ item: item(selection), is_grading_enabled: true,
  links: paged([{ state: "resolved", producer_local_id: "T1", logical_item_id: id("l1"), relation_id: id("rel-1"), evidence_ref: "/findings/1/task_ids/0" },
    { state: "unresolved", producer_local_id: "T404", unresolved_target_ref: "logical_item:task:T404", relation_id: id("rel-2"), evidence_ref: "/findings/1/task_ids/1" }]),
  questions: paged(questions), ...overrides });

export const acknowledged = (value: string, overrides: Partial<ObservationHumanSubmissionAcknowledgment> = {}): ObservationHumanSubmissionAcknowledgment => ({ task_id: null, status: "recorded", submission_id: "s", reviewer_id: id("oakridge-operator"), observation_id: id("new-observation"),
  execution_id: id("new-execution"), evidence_set_id: id("evidence-support"), evaluator_definition_id: id("human"), run_id: id("run-1"), occurrence_id: OCCURRENCE, question: { question_id: id("assessment_finding.evidence_support"), question_version: "1" }, answer: { state: "answered", kind: "choice", value },
  rationale: null, corrects_observation_id: null, recorded_at: "2026-11-01T00:00:00Z", ...overrides });

const drilldown = (selector: object, stage: string) => ({ logical_item_id: id("l1"), stage, selector }) as ObservationStageCompositeRead["items"];
const stageOf = (stage: string, overrides: Partial<ObservationStageCompositeRead> = {}): ObservationStageCompositeRead => ({ stage, publication: { state: "pending" }, coverage: "gap",
  totals: { contributing_items: 0, not_ready_items: 0, pending_items: 0, failed_items: 0, budget_deferred_items: 0, grading_off_items: 0, superseded_items: 0, superseded_answers: 0 },
  questions: paged([]), answers: paged([]), statuses: paged([]), disagreements: paged([]), items: drilldown({ kind: "items" }, stage), history: drilldown({ kind: "history" }, stage), ...overrides });
export const taskComposite = (task_id = "T1"): ObservationCompositeRead => ({ run_id: id("run-1"), logical_item_id: id("l1"), scope: "task", producer_local_id: task_id, coverage: "linked", stages: paged([
  stageOf("analysis"),
  stageOf("implementation", { publication: { state: "published", is_final: false, unit_ids: paged(["run-1/implementation/one"]) }, coverage: "linked",
    totals: { contributing_items: 2, not_ready_items: 0, pending_items: 1, failed_items: 0, budget_deferred_items: 0, grading_off_items: 0, superseded_items: 1, superseded_answers: 1 },
    answers: paged<ObservationAnswerCount>([{ question: { question_id: id("assessment_finding.evidence_support"), question_version: "1" }, grader: { kind: "machine", evaluator_definition_id: id("jev"), backend_kind: "jev_direct", model: "jev-1.14.0" },
      answer: { state: "answered", value: "does_not_support" }, count: 7, drilldown: drilldown({ kind: "answer", marker: "support" }, "implementation") }]),
    statuses: paged<ObservationStatusCount>([{ question: { question_id: id("assessment_finding.correctness"), question_version: "1" }, evaluator_definition_id: id<ObservationEvaluatorDefinitionId>("jev"), status: { state: "budget_deferred" }, count: 5, drilldown: drilldown({ kind: "status" }, "implementation") }]),
    disagreements: paged<ObservationDisagreementCount>([{ question: { question_id: id("assessment_finding.evidence_support"), question_version: "1" }, item_count: 9, drilldown: drilldown({ kind: "disagreement" }, "implementation") }]) }),
  stageOf("integration", { publication: { state: "published", is_final: true, unit_ids: paged(["run-1/integration/final"]) }, coverage: "linked",
    totals: { contributing_items: 1, not_ready_items: 0, pending_items: 0, failed_items: 0, budget_deferred_items: 0, grading_off_items: 0, superseded_items: 0, superseded_answers: 0 } }),
]) });
export const findingRow = (selection: ObservationItemAddress, overrides: Partial<ObservationAddressedItem> = {}, links: ObservationGradeableItemRow["links"] = paged([])): ObservationGradeableItemRow => ({ item: item(selection, overrides), links });
