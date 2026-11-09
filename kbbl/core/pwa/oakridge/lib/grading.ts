// Pure derivations for the item panel and the grading section. Hidden mode is decided here, so a
// component holding answers or composite counts never has them to render while they are hidden.
import type { ChipTone } from "../../components/atoms/Chip";
import type { ObservationAnswerCount, ObservationAnswerKey, ObservationCompositeDrilldownKey, ObservationDisagreementCount, ObservationGraderKey, ObservationItemStatusKey, ObservationStatusCount } from "../grading-contracts/grading/composite";
import type { ObservationEvidenceReference } from "../grading-contracts/grading/evidence";
import type { ObservationMeasurementState } from "../grading-contracts/grading/execution";
import type { ObservationAnswerRead, ObservationCompositeRead, ObservationHumanReadiness, ObservationItemAddress, ObservationLogicalLinkRead, ObservationStageCompositeRead } from "../grading-contracts/grading/item-reads";
import type { ObservationGradeAnswer } from "../grading-contracts/grading/observation";
import type { ObservationQuestionKey } from "../grading-contracts/grading/question";
import type { ObservationAttemptRead } from "../grading-contracts/storage/execution-store";
import type { ObservationItemStatusResponse } from "../grading-contracts/storage/grading-record-store";
import type { ObservationReviewerId } from "../grading-contracts/domain/identity";
import type { ObservationJsonValue } from "../grading-contracts/domain/primitives";
import type { SubmissionResult } from "../grading-types";
import type { ArtifactSource } from "../artifact-types";
import { parseCompositeId } from "../adapters/core";
import { artifactRevisionIdOf } from "./grading-ids";

/** The address of a finding on screen, from the exact revision the viewer shows. No revision identity, no address. */
export function selectItemSelection(source: Pick<ArtifactSource, "revision_id"> | undefined, item_path: string): ObservationItemAddress | null {
  if (!source) return null;
  const parsed = parseCompositeId(source.revision_id, "artifact");
  if (!parsed.ok) return null;
  const separator = parsed.value.name.indexOf(":");
  return separator < 0 ? null : { source_revision_id: artifactRevisionIdOf(parsed.value.name.slice(separator + 1)), item_path };
}
/** Every finding an artifact revision shows, addressed the same way each row addresses its own. */
export const selectFindingSelections = (source: Pick<ArtifactSource, "revision_id"> | undefined, item_paths: readonly string[]): readonly ObservationItemAddress[] =>
  item_paths.flatMap((item_path) => { const selection = selectItemSelection(source, item_path); return selection ? [selection] : []; });
export const itemSelectionKey = ({ source_revision_id, item_path }: ObservationItemAddress): string => JSON.stringify([source_revision_id, item_path]);
export const areSelectionsEqual = (left: ObservationItemAddress, right: ObservationItemAddress): boolean => itemSelectionKey(left) === itemSelectionKey(right);

const QUESTION_LABELS: Readonly<Record<string, string>> = {
  "finding.relevance": "Relevance",
  "assessment_finding.correctness": "Correctness",
  "assessment_finding.evidence_support": "Evidence support",
};
export const questionLabel = ({ question_id }: Pick<ObservationQuestionKey, "question_id">): string => QUESTION_LABELS[question_id] ?? question_id;
export const sameQuestion = (left: ObservationQuestionKey, right: ObservationQuestionKey): boolean =>
  left.question_id === right.question_id && left.question_version === right.question_version;

export const answerValueLabel = (value: unknown): string => typeof value === "string" ? value.replaceAll("_", " ") : JSON.stringify(value);
export const gradeAnswerLabel = (answer: ObservationGradeAnswer): string =>
  answer.state === "answered" ? answerValueLabel(answer.value) : `${answer.state}: ${answer.reason}`;
export const answerKeyLabel = (answer: ObservationAnswerKey): string => answer.state === "answered" ? answerValueLabel(answer.value) : answer.state;
const NEGATIVE_ANSWERS: ReadonlySet<unknown> = new Set(["irrelevant", "contradicted", "does_not_support"]);
const AFFIRMATIVE_ANSWERS: ReadonlySet<unknown> = new Set(["relevant", "supported", "supports"]);
/** A negative or unclear choice is an actual answer: it never takes a tone that reads as missing or failed work. */
export const answerTone = (value: unknown): ChipTone => AFFIRMATIVE_ANSWERS.has(value) ? "success" : NEGATIVE_ANSWERS.has(value) ? "warning" : "neutral";

export function graderLabel(grader: ObservationGraderKey): string {
  if (grader.kind === "human") return `Reviewer ${grader.reviewer_id}`;
  return grader.model ? `${grader.backend_kind} (${grader.model})` : grader.backend_kind;
}

export interface StatusDisplay { readonly label: string; readonly tone: ChipTone; readonly detail: string | null }
/** Every state a measurement can be in reads differently from every other, and from an answer. */
export function measurementDisplay(measurement: ObservationMeasurementState): StatusDisplay {
  switch (measurement.state) {
    case "not_ready": return { label: "Not ready", tone: "muted", detail: `${measurement.code}: ${measurement.detail}` };
    case "grading_off": return { label: "Automatic grading off", tone: "muted", detail: null };
    case "awaiting_admission": return { label: "Awaiting admission", tone: "muted", detail: null };
    case "pending": return { label: "Pending", tone: "info", detail: measurement.status };
    case "budget_deferred": return { label: "Budget deferred", tone: "warning", detail: "No request was made: the run's allowance cannot fit the next one." };
    case "failed": return { label: "Failed", tone: "danger", detail: measurement.error || measurement.terminal_cause };
    case "answered": return { label: gradeAnswerLabel(measurement.answer), tone: measurement.answer.state === "answered" ? answerTone(measurement.answer.value) : "neutral", detail: null };
  }
}
export function statusKeyLabel(status: ObservationItemStatusKey): string {
  switch (status.state) {
    case "not_ready": return `Not ready (${status.code})`;
    case "grading_off": return "Automatic grading off";
    case "awaiting_admission": return "Awaiting admission";
    case "pending": return "Pending";
    case "budget_deferred": return "Budget deferred";
    case "failed": return status.terminal_cause ? `Failed (${status.terminal_cause})` : "Failed";
  }
}

/** The operator's own progress on one item. Only their own answers are read, so it reveals nothing hidden mode omits. */
export type OwnGradeProgress =
  | { readonly kind: "no_human_question" }
  | { readonly kind: "open"; readonly answered: number; readonly total: number }
  | { readonly kind: "graded"; readonly total: number };
export function selectOwnGradeProgress(status: ObservationItemStatusResponse, reviewer_id: ObservationReviewerId): OwnGradeProgress {
  const answerable = status.questions.items.filter((question) => question.human.state !== "no_human_evaluator");
  if (answerable.length === 0) return { kind: "no_human_question" };
  const answered = answerable.filter((question) => question.answers.items.some((answer) => answer.reviewer_id === reviewer_id)).length;
  return answered === answerable.length ? { kind: "graded", total: answerable.length } : { kind: "open", answered, total: answerable.length };
}
/** "Graded" only once every question the operator can answer has their answer. */
export const gradeActionLabel = (progress: OwnGradeProgress | null): string => progress?.kind === "graded" ? "Graded" : "Grade";

export type AutomaticGlyph = "affirmative" | "negative" | "unclear" | "not_ready" | "waiting" | "budget_deferred" | "failed" | "grading_off";
/** One automatic evaluator's state on one question, at a glance. The item panel holds everything else. */
export interface AutomaticGlance { readonly key: string; readonly glyph: AutomaticGlyph; readonly tone: ChipTone; readonly label: string }
function glyphOf(measurement: ObservationMeasurementState): AutomaticGlyph {
  switch (measurement.state) {
    case "answered":
      if (measurement.answer.state !== "answered") return "unclear";
      return AFFIRMATIVE_ANSWERS.has(measurement.answer.value) ? "affirmative" : NEGATIVE_ANSWERS.has(measurement.answer.value) ? "negative" : "unclear";
    case "not_ready": return "not_ready";
    case "awaiting_admission": case "pending": return "waiting";
    case "budget_deferred": return "budget_deferred";
    case "failed": return "failed";
    case "grading_off": return "grading_off";
  }
}
export const selectAutomaticGlances = (status: ObservationItemStatusResponse): readonly AutomaticGlance[] =>
  status.questions.items.flatMap((question) => question.machine.items.map((machine) => {
    const display = measurementDisplay(machine.measurement);
    return { key: `${question.question.question_id}/${machine.evaluator_definition_id}`, glyph: glyphOf(machine.measurement), tone: display.tone, label: `${questionLabel(question.question)}: ${display.label}` };
  }));

export type HumanFormState =
  /** A reviewer answers with text, so only the question's text choices are offered. */
  | { readonly kind: "open"; readonly choices: readonly string[] }
  | { readonly kind: "not_ready"; readonly code: string; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string };
/** Only this question's own readiness disables its form: another question, a task or grading off never does. */
export function selectHumanForm(human: ObservationHumanReadiness, allowed_values: readonly ObservationJsonValue[] | null): HumanFormState {
  if (human.state === "not_ready") return { kind: "not_ready", code: human.code, detail: human.detail };
  if (human.state === "no_human_evaluator") return { kind: "unavailable", detail: "This question was captured with no human evaluator." };
  const choices = (allowed_values ?? []).filter((value): value is string => typeof value === "string");
  return choices.length > 0 ? { kind: "open", choices } : { kind: "unavailable", detail: "This question offers no choices." };
}

/** The operator's answer that stands, at the end of its own correction chain. */
export const selectOwnCurrentAnswer = (own: readonly ObservationAnswerRead[]): ObservationAnswerRead | null => {
  const replaced = new Set(own.flatMap((answer) => answer.supersedes_observation_id ? [answer.supersedes_observation_id] : []));
  return own.filter((answer) => !replaced.has(answer.observation_id)).at(-1) ?? null;
};

/** The operator's replaced answers: everything but the one that stands. */
export const selectEarlierOwnAnswers = (own: readonly ObservationAnswerRead[], current: ObservationAnswerRead | null): readonly ObservationAnswerRead[] =>
  own.filter((answer) => answer.observation_id !== current?.observation_id);

/** What the operator has edited; null in a field means it still shows the current answer's value. */
export interface GradeDraft { readonly choice: string | null; readonly rationale: string | null }
export const EMPTY_GRADE_DRAFT: GradeDraft = { choice: null, rationale: null };
export interface GradeEditor { readonly choice: string | null; readonly rationale: string; readonly is_changed: boolean }
const answerChoice = (answer: ObservationAnswerRead | null): string | null => answer?.answer.state === "answered" && typeof answer.answer.value === "string" ? answer.answer.value : null;
/** A blank explanation is no explanation. */
export const normalizeRationale = (rationale: string): string | null => rationale.trim() === "" ? null : rationale;
/**
 * The form as shown: the current answer's choice and explanation unless edited. Either field changing
 * makes a correction; an explanation alone can be corrected while the choice stays.
 */
export function selectGradeEditor(current: ObservationAnswerRead | null, draft: GradeDraft): GradeEditor {
  const choice = draft.choice ?? answerChoice(current);
  const rationale = draft.rationale ?? current?.rationale ?? "";
  const is_changed = choice !== null && (choice !== answerChoice(current) || normalizeRationale(rationale) !== (current?.rationale ?? null));
  return { choice, rationale, is_changed };
}

/** Refusals that mean this form's view of the operator's own answers is out of date. */
export const isStaleAnswerRefusal = (result: SubmissionResult): boolean =>
  result.kind === "refused" && (result.code === "stale_correction" || result.code === "correction_required");

export interface AttemptDisplay { readonly label: string; readonly outcome: string; readonly tone: ChipTone; readonly request: string; readonly cost: string; readonly failure_category: string | null }
/** One provider attempt as a reviewer inspects it: outcome, whether a request left, what it cost and why it failed. */
export function attemptDisplay(attempt: ObservationAttemptRead): AttemptDisplay {
  const outcome = attempt.outcome === "completed" ? { outcome: "Completed", tone: "success" as const }
    : attempt.outcome === "failed" ? { outcome: "Failed", tone: "danger" as const } : { outcome: "In flight", tone: "muted" as const };
  return { label: `Attempt ${attempt.attempt}`, ...outcome,
    request: attempt.request_sent ? `request sent${attempt.provider_request_id ? ` (${attempt.provider_request_id})` : ""}` : "no request sent",
    cost: `cost ${attempt.charged_cost.toFixed(4)} of ${attempt.admitted_estimate.toFixed(4)} admitted`, failure_category: attempt.failure_category };
}

/** One stage of a task as that task's read returned it; null when the read has none by that name. */
export const selectTaskStage = (task: ObservationCompositeRead | undefined, stage: string): ObservationStageCompositeRead | null =>
  task?.stages.items.find((candidate) => candidate.stage === stage) ?? null;

/** One count's drilldown identity: the same key always names the same rows, and any field differing names others. */
export const drilldownIdentity = (key: ObservationCompositeDrilldownKey): string => JSON.stringify([key.logical_item_id, key.stage, key.selector]);

export type SubmissionNotice =
  | { readonly kind: "none" }
  | { readonly kind: "pending" }
  | { readonly kind: "saved"; readonly is_duplicate: boolean; readonly answer: string }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };
/** "Saved" comes from an acknowledgment and nothing else: never while pending, after a refusal or after no answer. */
export function selectSubmissionNotice(input: { readonly is_pending: boolean; readonly result: SubmissionResult | undefined }): SubmissionNotice {
  if (input.is_pending) return { kind: "pending" };
  if (!input.result) return { kind: "none" };
  switch (input.result.kind) {
    case "acknowledged": return { kind: "saved", is_duplicate: input.result.acknowledgment.status === "duplicate", answer: gradeAnswerLabel(input.result.acknowledgment.answer) };
    case "refused": return { kind: "refused", message: input.result.message };
    case "failed": return { kind: "failed", message: input.result.message };
  }
}

export interface ReferenceDisplay { readonly source_label: string; readonly location: string; readonly is_agent_reported: boolean; readonly is_absent: boolean }
/** Where one frozen reference came from, exactly. Reported output is labelled as the agent's, and an absent file as absent. */
export function referenceDisplay(reference: ObservationEvidenceReference): ReferenceDisplay {
  switch (reference.source) {
    case "revision": return { source_label: "Revision", location: reference.item_path ? `${reference.revision_id} ${reference.item_path}` : reference.revision_id, is_agent_reported: false, is_absent: false };
    case "run_input": return { source_label: "Launch input", location: `${reference.run_id} ${reference.input_path}`, is_agent_reported: false, is_absent: false };
    case "repository": {
      const lines = reference.line_range ? `:${reference.line_range.start}-${reference.line_range.end}` : "";
      return { source_label: "Repository", location: `${reference.repository_key} ${reference.path}${lines} @ ${reference.commit_sha}`, is_agent_reported: false, is_absent: reference.is_absent };
    }
    case "reported": return { source_label: "Agent-reported", location: `${reference.revision_id} ${reference.item_path}`, is_agent_reported: true, is_absent: false };
  }
}

/** A finding's line, read from its own captured value. */
export function selectItemText(value: unknown): string {
  if (typeof value === "string") return value;
  const description = (value as { readonly description?: unknown } | null)?.description;
  return typeof description === "string" && description.trim() !== "" ? description : "No description recorded.";
}

export const taskLinkLabel = (link: ObservationLogicalLinkRead): string => link.state === "resolved" ? link.producer_local_id : `${link.producer_local_id} (unresolved)`;

export const STAGE_LABELS: Readonly<Record<string, string>> = { analysis: "Analysis", implementation: "Implementation", integration: "Integration" };
export const stageLabel = (stage: string): string => STAGE_LABELS[stage] ?? stage;
export function stagePublicationLabel(stage: Pick<ObservationStageCompositeRead, "publication">): string {
  if (stage.publication.state === "pending") return "Pending";
  return stage.publication.is_final ? "Final results" : "Published";
}
const STAGE_ORDER = ["analysis", "implementation", "integration"];
export const GRADING_STAGES: readonly string[] = STAGE_ORDER;

export interface HiddenStageView { readonly kind: "hidden"; readonly stage: string; readonly publication: string; readonly coverage: ObservationStageCompositeRead["coverage"]; readonly contributing_items: number }
export interface RevealedStageView {
  readonly kind: "revealed";
  readonly stage: string;
  readonly publication: string;
  readonly coverage: ObservationStageCompositeRead["coverage"];
  readonly contributing_items: number;
  readonly answers: readonly ObservationAnswerCount[];
  readonly statuses: readonly ObservationStatusCount[];
  readonly disagreements: readonly ObservationDisagreementCount[];
  readonly composite: ObservationStageCompositeRead;
}
/** While hidden a stage says only what linking alone determines: it carries no answer, count of answers or status. */
export const selectStageView = (stage: ObservationStageCompositeRead, is_revealed: boolean): HiddenStageView | RevealedStageView => {
  const shared = { stage: stage.stage, publication: stagePublicationLabel(stage), coverage: stage.coverage, contributing_items: stage.totals.contributing_items };
  return is_revealed ? { kind: "revealed", ...shared, answers: stage.answers.items, statuses: stage.statuses.items, disagreements: stage.disagreements.items, composite: stage } : { kind: "hidden", ...shared };
};
