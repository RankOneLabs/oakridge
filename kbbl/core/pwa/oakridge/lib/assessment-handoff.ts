import type { Assessment, NextAction } from "./assessment";
import type { Result } from "../../lib/result";

export type AssessmentPublication = Omit<Assessment, "recommended_next_actions"> & {
  readonly recommended_next_actions: readonly (NextAction | { readonly text: string })[];
};
import type { ParkedGate, SentReviewFeedback } from "../artifact-types";
import { parseCompositeId, REQUEST_BUILD_CHANGES } from "../adapters/core";

/** One editable recommendation from the registered assessment body. */
export interface HandoffItem {
  readonly id: string;
  readonly text: string;
  readonly is_included: boolean;
}

export function selectHandoffItems(assessment: Assessment): HandoffItem[] {
  return assessment.recommended_next_actions.map((action) => ({ id: action.id, text: action.text, is_included: true }));
}
export const hasHandoffItem = (assessment: Assessment, id: string): boolean => assessment.recommended_next_actions
  .some((action) => action.id === id);

/** The exact prompt shown in the preview and sent to the builder. */
export function composeHandoffText(items: readonly HandoffItem[]): string {
  const included = items.filter((item) => item.is_included);
  if (included.length === 0) return "";
  return `Recommended next actions for the builder:\n\n${included.map((item, index) => `${index + 1}. ${item.text}`).join("\n")}`;
}

/** Publish a successor assessment with one recommendation removed. */
export function withItemRemoved(body: Assessment, id: string): Result<Assessment, string> {
  if (!hasHandoffItem(body, id)) return { ok: false, error: "Action is absent from the current assessment. Refresh and review it again." };
  return { ok: true, value: {
    ...body,
    recommended_next_actions: body.recommended_next_actions.filter((action) => action.id !== id),
  } };
}

/** Publish a successor assessment with one recommendation appended. */
export function withItemAdded(body: Assessment, text: string): AssessmentPublication {
  return { ...body, recommended_next_actions: [...body.recommended_next_actions, { text }] };
}
export function withItemTextChanged(body: Assessment, id: string, text: string): Assessment {
  return { ...body, recommended_next_actions: body.recommended_next_actions.map((action) =>
    action.id === id ? { ...action, text } : action) };
}

/** What the send control offers: the open review to send on, a send already recorded, or no review to send on. */
export type HandoffSendTarget =
  | { readonly kind: "review"; readonly gate: ParkedGate }
  | { readonly kind: "sent" }
  | { readonly kind: "no_review" };

/** A recorded send stays shown until a different review opens, which the assessor's next assessment brings. */
export function selectHandoffSendTarget(gate: ParkedGate | null, hasRecordedSend: boolean): HandoffSendTarget {
  if (hasRecordedSend) return { kind: "sent" };
  if (gate !== null) return { kind: "review", gate };
  return { kind: "no_review" };
}

/** Match both the recorded send and the open review to the revision being displayed. */
export function selectHandoffRound(revisionId: string, unitLabel: string, gate: ParkedGate | null,
  feedback: readonly SentReviewFeedback[]): HandoffSendTarget {
  const revisionTarget = targetRevisionId(revisionId);
  const hasRecordedSend = feedback.some((entry) => entry.review === "assessment_review"
    && entry.decision === REQUEST_BUILD_CHANGES && entry.unit_id === unitLabel
    && entry.target_revision_id === revisionTarget);
  const gateRevision = gate?.artifact_revision_id ? targetRevisionId(gate.artifact_revision_id) : null;
  return selectHandoffSendTarget(gateRevision === revisionTarget ? gate : null, hasRecordedSend);
}

function targetRevisionId(revisionId: string): string {
  const parsed = parseCompositeId(revisionId, "artifact");
  return parsed.ok ? parsed.value.name.slice(parsed.value.name.indexOf(":") + 1) : revisionId;
}

export const NO_REVIEW_REASON = "This revision has no open assessment review to record the request on.";

/** Whether the composed request can be recorded on the review, and why not when it cannot. */
export type HandoffSendability =
  | { readonly kind: "sendable"; readonly artifact_revision_id: string }
  | { readonly kind: "blocked"; readonly reason: string };

export function selectHandoffSendability(preview: string, gate: ParkedGate): HandoffSendability {
  if (preview.length === 0) return { kind: "blocked", reason: "Include at least one next action to send." };
  if (gate.artifact_revision_id === null) return { kind: "blocked", reason: NO_REVIEW_REASON };
  if (!gate.actionable) return { kind: "blocked", reason: "The run has moved on, so this review can no longer take a decision." };
  if (!gate.offered_decisions.includes(REQUEST_BUILD_CHANGES)) return { kind: "blocked", reason: "Request build changes is not offered for this review." };
  return { kind: "sendable", artifact_revision_id: gate.artifact_revision_id };
}


// Current-contract adjudication: local pending state never mutates the assessor's revision.
import type { CurrentAssessment } from "./current-assessment";
import type { OperatorAdjudication, OperatorAddedActionEntry, OperatorDisposition, OperatorProposedActionEntry } from "../operator-contracts/domain/adjudication";
import type { OperatorActionSource } from "../operator-contracts/domain/assessment";
import { composeBuilderFeedback } from "../operator-contracts/domain/builder-feedback";
import { randomUuid } from "../../lib/random-uuid";
import type { OperatorRevisionDecision } from "../operator-contracts/projections/unit-view";
/** Unit history is oldest first; dispositions belong only to the displayed revision. */
export function selectRecordedAssessmentDecision(decisions: readonly OperatorRevisionDecision[], revisionId: string): OperatorRevisionDecision | null {
  return decisions.reduce<OperatorRevisionDecision | null>((latest, decision) =>
    (decision.assessment_revision_id ?? decision.target_revision_id) === revisionId ? decision : latest, null);
}
export type PendingDisposition =
  | { readonly action_id: string; readonly kind: "undecided" }
  | { readonly action_id: string; readonly kind: "decided"; readonly disposition: OperatorDisposition; readonly final_text?: string; readonly reason?: string };
export interface AdjudicationState { readonly assessment: CurrentAssessment; readonly dispositions: readonly PendingDisposition[]; readonly added_actions: readonly OperatorAddedActionEntry[] }
export type DispositionChoice = { readonly kind: "accept" } | { readonly kind: "edit"; readonly final_text: string } | { readonly kind: "reject"; readonly reason?: string };
export type AdjudicationEffect = "accept" | "request_build_changes" | "request_changes";
export function initialAdjudication(assessment: CurrentAssessment): AdjudicationState {
  return { assessment, dispositions: assessment.next_actions.map(action => ({ action_id: action.id, kind: "undecided" })), added_actions: [] };
}
export function setDisposition(state: AdjudicationState, action_id: string, choice: DispositionChoice): AdjudicationState {
  const disposition: PendingDisposition = choice.kind === "accept" ? { action_id, kind: "decided", disposition: "accepted" }
    : choice.kind === "edit" ? { action_id, kind: "decided", disposition: "modified", final_text: choice.final_text }
    : { action_id, kind: "decided", disposition: "rejected", reason: choice.reason };
  return { ...state, dispositions: state.dispositions.map(entry => entry.action_id === action_id ? disposition : entry) };
}
export interface AddedActionInput { readonly audience: "builder" | "operator"; readonly source: OperatorActionSource; readonly text: string; readonly reason?: string }
export function addAction(state: AdjudicationState, input: AddedActionInput): AdjudicationState {
  return { ...state, added_actions: [...state.added_actions, { action_id: randomUuid(), origin: "operator", final_text: input.text, audience: input.audience, source: input.source, reason: input.reason }] };
}
function selectDecidedEntries(state: AdjudicationState): readonly OperatorProposedActionEntry[] {
  return state.assessment.next_actions.flatMap(action => {
    const pending = state.dispositions.find(entry => entry.action_id === action.id);
    return pending?.kind === "decided" ? [{ action_id: action.id, original_text: action.text, audience: action.audience, source: action.source,
      disposition: pending.disposition, ...(pending.final_text === undefined ? {} : { final_text: pending.final_text }), ...(pending.reason === undefined ? {} : { reason: pending.reason }) }] : [];
  });
}
export const selectBuilderPreview = (state: AdjudicationState): string => composeBuilderFeedback(selectDecidedEntries(state), state.added_actions);
export type AdjudicationSendability = { readonly kind: "sendable" } | { readonly kind: "blocked"; readonly reason: string };
export function selectSendability(state: AdjudicationState, effect: AdjudicationEffect): AdjudicationSendability {
  if (state.dispositions.some(entry => entry.kind === "undecided")) return { kind: "blocked", reason: "Decide every assessor action before submitting." };
  if (state.dispositions.some(entry => entry.kind === "decided" && entry.disposition === "modified" && !entry.final_text?.trim())) return { kind: "blocked", reason: "Edited actions need replacement text." };
  if (state.added_actions.some(entry => !entry.final_text.trim())) return { kind: "blocked", reason: "Added actions need text." };
  if (effect !== "accept" && !selectBuilderPreview(state).trim()) return { kind: "blocked", reason: "Accept, edit or add at least one builder action to request changes." };
  return { kind: "sendable" };
}
export function selectAdjudicationPayload(state: AdjudicationState, effect: AdjudicationEffect): Result<OperatorAdjudication, string> {
  const sendability = selectSendability(state, effect);
  return sendability.kind === "blocked" ? { ok: false, error: sendability.reason } : { ok: true,
    value: { entries: selectDecidedEntries(state), added_actions: state.added_actions, builder_feedback: selectBuilderPreview(state) } };
}
export interface AdjudicationSourceOption { readonly value: string; readonly label: string; readonly source: OperatorActionSource }
export function selectAdjudicationSources(assessment: CurrentAssessment): readonly AdjudicationSourceOption[] {
  return [...assessment.item_assessments.map(item => ({ value: `item_assessment:${item.subject.id}`, label: `${item.subject.kind}: ${item.subject.id}`, source: { kind: "item_assessment" as const, id: item.subject.id } })),
    ...assessment.additional_findings.map(finding => ({ value: `additional_finding:${finding.id}`, label: `Finding: ${finding.id}`, source: { kind: "additional_finding" as const, id: finding.id } }))];
}
