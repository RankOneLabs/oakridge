// Current-contract adjudication: local pending state never mutates the assessor's revision.
import type { Result } from "../../lib/result";
import { randomUuid } from "../../lib/random-uuid";
import type { ParkedGate } from "../artifact-types";
import { isAdjudicationDecision } from "../adapters/gates";
import type { OperatorAdjudication, OperatorAddedActionEntry, OperatorDisposition, OperatorProposedActionEntry } from "../operator-contracts/domain/adjudication";
import type { OperatorActionSource } from "../operator-contracts/domain/assessment";
import { composeBuilderFeedback } from "../operator-contracts/domain/builder-feedback";
import type { OperatorDeclaredDecisionEffect } from "../operator-contracts/core-client/core-types";
import type { OperatorDecisionDefinition, OperatorRevisionDecision } from "../operator-contracts/projections/unit-view";
import type { CurrentAssessment } from "./current-assessment";
import { selectHandoffRevisionId } from "./handoff-provenance";

export const NO_REVIEW_REASON = "This revision has no open assessment review to record a decision on.";

/** The operator's pending choice for one assessor action, in the contract's disposition terms. */
export type PendingDisposition =
  | { readonly action_id: string; readonly disposition: "accepted" }
  | { readonly action_id: string; readonly disposition: "modified"; readonly final_text: string }
  | { readonly action_id: string; readonly disposition: "rejected"; readonly reason: string };
export interface AdjudicationState { readonly assessment: CurrentAssessment; readonly dispositions: readonly PendingDisposition[]; readonly added_actions: readonly OperatorAddedActionEntry[] }
export type DispositionChoice = { readonly kind: "accept" } | { readonly kind: "edit"; readonly final_text: string } | { readonly kind: "reject"; readonly reason: string };

/** What the operator reads for each disposition: the control that picks it, and the word once recorded. */
export const DISPOSITION_CONTROL_LABEL: Readonly<Record<OperatorDisposition, string>> = { accepted: "Keep", modified: "Edit", rejected: "Drop" };
export const DISPOSITION_RECORDED_LABEL: Readonly<Record<OperatorDisposition, string>> = { accepted: "Kept", modified: "Edited", rejected: "Dropped" };

/** Every assessor action starts kept; the operator touches only the ones to edit or drop. */
export function initialAdjudication(assessment: CurrentAssessment): AdjudicationState {
  return { assessment, dispositions: assessment.next_actions.map(action => ({ action_id: action.id, disposition: "accepted" })), added_actions: [] };
}
const toDisposition = (action_id: string, choice: DispositionChoice): PendingDisposition =>
  choice.kind === "accept" ? { action_id, disposition: "accepted" }
    : choice.kind === "edit" ? { action_id, disposition: "modified", final_text: choice.final_text }
    : { action_id, disposition: "rejected", reason: choice.reason };
export function setDisposition(state: AdjudicationState, action_id: string, choice: DispositionChoice): AdjudicationState {
  return { ...state, dispositions: state.dispositions.map(entry => entry.action_id === action_id ? toDisposition(action_id, choice) : entry) };
}
export const selectPendingDisposition = (state: AdjudicationState, action_id: string): PendingDisposition =>
  state.dispositions.find(entry => entry.action_id === action_id) ?? { action_id, disposition: "accepted" };

export interface AddedActionInput { readonly audience: "builder" | "operator"; readonly source: OperatorActionSource; readonly text: string }
export function addAction(state: AdjudicationState, input: AddedActionInput): AdjudicationState {
  return { ...state, added_actions: [...state.added_actions, { action_id: randomUuid(), origin: "operator", final_text: input.text, audience: input.audience, source: input.source }] };
}

function selectEntries(state: AdjudicationState): readonly OperatorProposedActionEntry[] {
  return state.assessment.next_actions.map(action => {
    const pending = selectPendingDisposition(state, action.id);
    const base = { action_id: action.id, original_text: action.text, audience: action.audience, source: action.source };
    if (pending.disposition === "modified") return { ...base, disposition: "modified", final_text: pending.final_text };
    if (pending.disposition === "rejected") return { ...base, disposition: "rejected", ...(pending.reason.trim() ? { reason: pending.reason } : {}) };
    return { ...base, disposition: "accepted" };
  });
}
/** The exact text the builder receives on a send-back. */
export const selectBuilderPreview = (state: AdjudicationState): string => composeBuilderFeedback(selectEntries(state), state.added_actions);
/** How many actions a send-back delivers to the builder: kept or edited builder actions, plus added ones. */
export const selectBuilderActionCount = (state: AdjudicationState): number =>
  selectEntries(state).filter(entry => entry.audience === "builder" && entry.disposition !== "rejected").length
  + state.added_actions.filter(entry => entry.audience === "builder").length;

/** An adjudication either approves the assessment or sends it back with builder feedback. */
export type AdjudicationEffect = OperatorDeclaredDecisionEffect;
export type AdjudicationSendability = { readonly kind: "sendable" } | { readonly kind: "blocked"; readonly reason: string };
export const KEPT_BUILDER_ACTIONS_REASON = "Kept builder actions reach the builder only through a send-back. Drop them to accept.";
export function selectSendability(state: AdjudicationState, effect: AdjudicationEffect): AdjudicationSendability {
  if (state.dispositions.some(entry => entry.disposition === "modified" && !entry.final_text.trim())) return { kind: "blocked", reason: "Edited actions need replacement text." };
  if (state.added_actions.some(entry => !entry.final_text.trim())) return { kind: "blocked", reason: "Added actions need text." };
  const builder_action_count = selectBuilderActionCount(state);
  if (effect === "request_changes" && builder_action_count === 0) return { kind: "blocked", reason: "Keep, edit or add a builder action to send." };
  if (effect === "approve" && builder_action_count > 0) return { kind: "blocked", reason: KEPT_BUILDER_ACTIONS_REASON };
  return { kind: "sendable" };
}
export function selectAdjudicationPayload(state: AdjudicationState, effect: AdjudicationEffect): Result<OperatorAdjudication, string> {
  const sendability = selectSendability(state, effect);
  return sendability.kind === "blocked" ? { ok: false, error: sendability.reason }
    : { ok: true, value: { entries: selectEntries(state), added_actions: state.added_actions, builder_feedback: selectBuilderPreview(state) } };
}

/** Where an action comes from, in the words the Items and Findings tabs use. */
export const selectActionSourceLabel = (source: OperatorActionSource): string =>
  source.kind === "additional_finding" ? `From finding ${source.id}` : `From ${source.id}`;

export interface AdjudicationSourceOption { readonly value: string; readonly label: string; readonly source: OperatorActionSource }
export function selectAdjudicationSources(assessment: CurrentAssessment): readonly AdjudicationSourceOption[] {
  return [...assessment.item_assessments.map(item => ({ value: `item_assessment:${item.subject.id}`, label: item.subject.id, source: { kind: "item_assessment" as const, id: item.subject.id } })),
    ...assessment.additional_findings.map(finding => ({ value: `additional_finding:${finding.id}`, label: `Finding ${finding.id}`, source: { kind: "additional_finding" as const, id: finding.id } }))];
}

/** Unit history is oldest first; dispositions belong only to the displayed revision. */
export function selectRecordedAssessmentDecision(decisions: readonly OperatorRevisionDecision[], revisionId: string): OperatorRevisionDecision | null {
  return decisions.reduce<OperatorRevisionDecision | null>((latest, decision) =>
    (decision.assessment_revision_id ?? decision.target_revision_id) === revisionId ? decision : latest, null);
}
export interface AdjudicationGateInput { readonly gate: ParkedGate | null; readonly revisionId: string; readonly decisions: readonly OperatorRevisionDecision[]; readonly hasSubmitted: boolean }
export interface AdjudicationGateState { readonly revision: string; readonly recordedDecision: OperatorRevisionDecision | null; readonly isRecorded: boolean; readonly isOpen: boolean }
/** The form records on the displayed revision only, while its review is open and before a decision exists. */
export function selectAdjudicationGate({ gate, revisionId, decisions, hasSubmitted }: AdjudicationGateInput): AdjudicationGateState {
  const revision = selectHandoffRevisionId(revisionId) ?? revisionId;
  const recordedDecision = selectRecordedAssessmentDecision(decisions, revision);
  const isRecorded = hasSubmitted || recordedDecision !== null;
  const isOpen = gate?.actionable === true && selectHandoffRevisionId(gate.artifact_revision_id ?? undefined) === revision && !isRecorded;
  return { revision, recordedDecision, isRecorded, isOpen };
}

/** A gate review decision the workflow declares, with the effect it records. */
export interface ReviewDecisionDefinition { readonly definition: OperatorDecisionDefinition; readonly effect: AdjudicationEffect }
function selectReviewDecisions(gate: ParkedGate | null): readonly ReviewDecisionDefinition[] {
  return (gate?.decision_definitions ?? []).flatMap(definition => definition.submit.kind === "review" ? [{ definition, effect: definition.submit.effect }] : []);
}
/** The decisions the gate declares with an adjudication payload, send-backs first, whatever each workflow names them. */
export function selectAdjudicationDecisions(gate: ParkedGate | null): readonly ReviewDecisionDefinition[] {
  const adjudicated = selectReviewDecisions(gate).filter(({ definition }) => isAdjudicationDecision(definition));
  return [...adjudicated.filter(({ effect }) => effect === "request_changes"), ...adjudicated.filter(({ effect }) => effect === "approve")];
}
/** The gate's plain request for assessment changes: a change request that carries feedback text rather than an adjudication. */
export function selectAssessmentChangeDecision(gate: ParkedGate | null): OperatorDecisionDefinition | null {
  return selectReviewDecisions(gate).find(({ definition, effect }) => effect === "request_changes" && !isAdjudicationDecision(definition)
    && definition.fields.some(field => field.key === "feedback"))?.definition ?? null;
}
export type AdjudicationDecision =
  | { readonly kind: "available"; readonly definition: OperatorDecisionDefinition; readonly revision_id: string }
  | { readonly kind: "unavailable"; readonly reason: string };
/** A declared decision submits on the gate's revision, unless the review is gone or its guard does not hold. */
export function selectAdjudicationDecision(gate: ParkedGate | null, decision: ReviewDecisionDefinition): AdjudicationDecision {
  if (!gate?.artifact_revision_id) return { kind: "unavailable", reason: NO_REVIEW_REASON };
  if (decision.definition.is_available === false) return { kind: "unavailable", reason: decision.definition.disabled_reason ?? "Decision unavailable" };
  return { kind: "available", definition: decision.definition, revision_id: gate.artifact_revision_id };
}
/** Why a decision's button is disabled: the pending adjudication first, then the decision's own guard. */
export function selectAdjudicationBlockReason(state: AdjudicationState, gate: ParkedGate | null, decision: ReviewDecisionDefinition): string | null {
  const sendability = selectSendability(state, decision.effect);
  if (sendability.kind === "blocked") return sendability.reason;
  const available = selectAdjudicationDecision(gate, decision);
  return available.kind === "unavailable" ? available.reason : null;
}
/** A send-back names how many actions it delivers. */
export const selectDecisionButtonLabel = (state: AdjudicationState, decision: ReviewDecisionDefinition): string =>
  decision.effect === "request_changes" ? `${decision.definition.label} (${selectBuilderActionCount(state)})` : decision.definition.label;
/** One line for a decision already recorded on the displayed revision. */
export const selectRecordedDecisionSummary = (decision: OperatorRevisionDecision): string =>
  `${decision.effect === "approve" ? "Accepted" : "Sent back"} (${decision.decision}) at ${new Date(decision.created_at).toLocaleString()}.`;
