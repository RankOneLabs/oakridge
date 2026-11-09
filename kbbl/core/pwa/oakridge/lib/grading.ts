// Pure derivations for the item panel and the grading section. Hidden mode is decided here, so a
// component holding answers or composite counts never has them to render while they are hidden.
import type { ChipTone } from "../../components/atoms/Chip";
import type { AnswerCount, AnswerKey, AnswerRead, DisagreementCount, EvidenceReference, GradeAnswer, GraderKey, HumanReadiness, ItemSelection, ItemStatusKey, MeasurementState, QuestionKey, StageComposite,
  StatusCount, SubmissionResult, TaskLink } from "../grading-types";
import type { ArtifactSource } from "../artifact-types";
import { parseCompositeId } from "../adapters/core";

/** The address of a finding on screen, from the exact revision the viewer shows. No revision identity, no address. */
export function selectItemSelection(source: Pick<ArtifactSource, "revision_id"> | undefined, item_path: string): ItemSelection | null {
  if (!source) return null;
  const parsed = parseCompositeId(source.revision_id, "artifact");
  if (!parsed.ok) return null;
  const separator = parsed.value.name.indexOf(":");
  return separator < 0 ? null : { source_revision_id: parsed.value.name.slice(separator + 1), item_path };
}
export const itemSelectionKey = ({ source_revision_id, item_path }: ItemSelection): string => JSON.stringify([source_revision_id, item_path]);
export const areSelectionsEqual = (left: ItemSelection, right: ItemSelection): boolean => itemSelectionKey(left) === itemSelectionKey(right);

const QUESTION_LABELS: Readonly<Record<string, string>> = {
  "finding.relevance": "Relevance",
  "assessment_finding.correctness": "Correctness",
  "assessment_finding.evidence_support": "Evidence support",
};
export const questionLabel = ({ question_id }: Pick<QuestionKey, "question_id">): string => QUESTION_LABELS[question_id] ?? question_id;
export const sameQuestion = (left: QuestionKey, right: QuestionKey): boolean =>
  left.question_id === right.question_id && left.question_version === right.question_version;

export const answerValueLabel = (value: unknown): string => typeof value === "string" ? value.replaceAll("_", " ") : JSON.stringify(value);
export const gradeAnswerLabel = (answer: GradeAnswer): string =>
  answer.state === "answered" ? answerValueLabel(answer.value) : `${answer.state}: ${answer.reason}`;
export const answerKeyLabel = (answer: AnswerKey): string => answer.state === "answered" ? answerValueLabel(answer.value) : answer.state;
const NEGATIVE_ANSWERS: ReadonlySet<unknown> = new Set(["irrelevant", "contradicted", "does_not_support"]);
const AFFIRMATIVE_ANSWERS: ReadonlySet<unknown> = new Set(["relevant", "supported", "supports"]);
/** A negative or unclear choice is an actual answer: it never takes a tone that reads as missing or failed work. */
export const answerTone = (value: unknown): ChipTone => AFFIRMATIVE_ANSWERS.has(value) ? "success" : NEGATIVE_ANSWERS.has(value) ? "warning" : "neutral";

export function graderLabel(grader: GraderKey): string {
  if (grader.kind === "human") return `Reviewer ${grader.reviewer_id}`;
  return grader.model ? `${grader.backend_kind} (${grader.model})` : grader.backend_kind;
}

export interface StatusDisplay { readonly label: string; readonly tone: ChipTone; readonly detail: string | null }
/** Every state a measurement can be in reads differently from every other, and from an answer. */
export function measurementDisplay(measurement: MeasurementState): StatusDisplay {
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
export function statusKeyLabel(status: ItemStatusKey): string {
  switch (status.state) {
    case "not_ready": return `Not ready (${status.code})`;
    case "grading_off": return "Automatic grading off";
    case "awaiting_admission": return "Awaiting admission";
    case "pending": return "Pending";
    case "budget_deferred": return "Budget deferred";
    case "failed": return status.terminal_cause ? `Failed (${status.terminal_cause})` : "Failed";
  }
}

export type HumanFormState =
  | { readonly kind: "open"; readonly choices: readonly string[] }
  | { readonly kind: "not_ready"; readonly code: string; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string };
/** Only this question's own readiness disables its form: another question, a task or grading off never does. */
export function selectHumanForm(human: HumanReadiness, allowed_values: readonly string[] | null): HumanFormState {
  if (human.state === "not_ready") return { kind: "not_ready", code: human.code, detail: human.detail };
  if (human.state === "no_human_evaluator") return { kind: "unavailable", detail: "This question was captured with no human evaluator." };
  return allowed_values && allowed_values.length > 0 ? { kind: "open", choices: allowed_values } : { kind: "unavailable", detail: "This question offers no choices." };
}

/** The operator's answer that stands, at the end of its own correction chain. */
export const selectOwnCurrentAnswer = (own: readonly AnswerRead[]): AnswerRead | null => {
  const replaced = new Set(own.flatMap((answer) => answer.supersedes_observation_id ? [answer.supersedes_observation_id] : []));
  return own.filter((answer) => !replaced.has(answer.observation_id)).at(-1) ?? null;
};

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
export function referenceDisplay(reference: EvidenceReference): ReferenceDisplay {
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

export const taskLinkLabel = (link: TaskLink): string => link.state === "resolved" ? link.producer_local_id : `${link.producer_local_id} (unresolved)`;

export const STAGE_LABELS: Readonly<Record<string, string>> = { analysis: "Analysis", implementation: "Implementation", integration: "Integration" };
export const stageLabel = (stage: string): string => STAGE_LABELS[stage] ?? stage;
export function stagePublicationLabel(stage: Pick<StageComposite, "publication">): string {
  if (stage.publication.state === "pending") return "Pending";
  return stage.publication.is_final ? "Final results" : "Published";
}
const STAGE_ORDER = ["analysis", "implementation", "integration"];
export const GRADING_STAGES: readonly string[] = STAGE_ORDER;

export interface HiddenStageView { readonly kind: "hidden"; readonly stage: string; readonly publication: string; readonly coverage: StageComposite["coverage"]; readonly contributing_items: number }
export interface RevealedStageView {
  readonly kind: "revealed";
  readonly stage: string;
  readonly publication: string;
  readonly coverage: StageComposite["coverage"];
  readonly contributing_items: number;
  readonly answers: readonly AnswerCount[];
  readonly statuses: readonly StatusCount[];
  readonly disagreements: readonly DisagreementCount[];
  readonly composite: StageComposite;
}
/** While hidden a stage says only what linking alone determines: it carries no answer, count of answers or status. */
export const selectStageView = (stage: StageComposite, is_revealed: boolean): HiddenStageView | RevealedStageView => {
  const shared = { stage: stage.stage, publication: stagePublicationLabel(stage), coverage: stage.coverage, contributing_items: stage.totals.contributing_items };
  return is_revealed ? { kind: "revealed", ...shared, answers: stage.answers.items, statuses: stage.statuses.items, disagreements: stage.disagreements.items, composite: stage } : { kind: "hidden", ...shared };
};
