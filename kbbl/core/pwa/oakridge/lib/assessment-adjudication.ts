// Current-contract adjudication: local pending state never mutates the assessor's revision.
import type { Result } from "../../lib/result";
import { randomUuid } from "../../lib/random-uuid";
import type { ParkedGate } from "../artifact-types";
import { isAdjudicationDecision } from "../adapters/gates";
import type { OperatorAdjudication, OperatorAddedActionEntry, OperatorDisposition, OperatorProposedActionEntry } from "../operator-contracts/domain/adjudication";
import type { OperatorActionSource, OperatorAssessmentAction } from "../operator-contracts/domain/assessment";
import { composeReworkFeedback } from "../operator-contracts/domain/rework-feedback";
import type { OperatorAdjudicationRole } from "../operator-contracts/core-client/core-types";
import type { OperatorDecisionDefinition, OperatorRevisionDecision } from "../operator-contracts/projections/unit-view";
import { selectAssessmentActions, type CurrentAssessment } from "./current-assessment";
import { selectHandoffRevisionId } from "./handoff-provenance";

export const NO_REVIEW_REASON = "This revision has no open assessment review to record a decision on.";

/** The operator's pending choice for one assessor action, in the contract's disposition terms. */
export type PendingDisposition =
  | { readonly action_id: string; readonly disposition: "accepted" }
  | { readonly action_id: string; readonly disposition: "modified"; readonly final_text: string }
  | { readonly action_id: string; readonly disposition: "rejected"; readonly reason: string };
/** What the operator has typed for one action, kept across choices so switching back to Edit or Drop restores it. */
export interface ActionDraft { readonly action_id: string; readonly final_text: string; readonly reason: string }
export interface AdjudicationState {
  readonly assessment: CurrentAssessment;
  readonly dispositions: readonly PendingDisposition[];
  readonly drafts: readonly ActionDraft[];
  readonly added_actions: readonly OperatorAddedActionEntry[];
}
export type DispositionChoice = { readonly kind: "accept" } | { readonly kind: "edit"; readonly final_text: string } | { readonly kind: "reject"; readonly reason: string };

/** What the operator reads for each disposition: the control that picks it, and the word once recorded. */
export const DISPOSITION_CONTROL_LABEL: Readonly<Record<OperatorDisposition, string>> = { accepted: "Keep", modified: "Edit", rejected: "Drop" };
export const DISPOSITION_RECORDED_LABEL: Readonly<Record<OperatorDisposition, string>> = { accepted: "Kept", modified: "Edited", rejected: "Dropped" };

export function initialAdjudication(assessment: CurrentAssessment): AdjudicationState {
  return { assessment, dispositions: [],
    drafts: assessment.next_actions.map(action => ({ action_id: action.id, final_text: action.text, reason: "" })), added_actions: [] };
}
const toDisposition = (action_id: string, choice: DispositionChoice): PendingDisposition =>
  choice.kind === "accept" ? { action_id, disposition: "accepted" }
    : choice.kind === "edit" ? { action_id, disposition: "modified", final_text: choice.final_text }
    : { action_id, disposition: "rejected", reason: choice.reason };
const toDraft = (draft: ActionDraft, choice: DispositionChoice): ActionDraft =>
  choice.kind === "edit" ? { ...draft, final_text: choice.final_text } : choice.kind === "reject" ? { ...draft, reason: choice.reason } : draft;
export function setDisposition(state: AdjudicationState, action_id: string, choice: DispositionChoice): AdjudicationState {
  const disposition = toDisposition(action_id, choice);
  const dispositions = selectPendingDisposition(state, action_id)
    ? state.dispositions.map(entry => entry.action_id === action_id ? disposition : entry)
    : [...state.dispositions, disposition];
  return { ...state, dispositions,
    drafts: state.drafts.map(draft => draft.action_id === action_id ? toDraft(draft, choice) : draft) };
}
export const selectPendingDisposition = (state: AdjudicationState, action_id: string): PendingDisposition | null =>
  state.dispositions.find(entry => entry.action_id === action_id) ?? null;
export const selectActionDraft = (state: AdjudicationState, action: OperatorAssessmentAction): ActionDraft =>
  state.drafts.find(draft => draft.action_id === action.id) ?? { action_id: action.id, final_text: action.text, reason: "" };
/** The choice a Keep, Edit or Drop click makes: Edit and Drop pick up what was typed for them before. */
export const selectDispositionChoice = (draft: ActionDraft, disposition: OperatorDisposition): DispositionChoice =>
  disposition === "accepted" ? { kind: "accept" } : disposition === "modified" ? { kind: "edit", final_text: draft.final_text } : { kind: "reject", reason: draft.reason };

export interface AddedActionInput { readonly audience: "rework" | "operator"; readonly source: OperatorActionSource; readonly text: string }
export function addAction(state: AdjudicationState, input: AddedActionInput): AdjudicationState {
  return { ...state, added_actions: [...state.added_actions, { action_id: randomUuid(), origin: "operator", final_text: input.text, audience: input.audience, source: input.source }] };
}
/** An added action is the operator's own until sent, so it can be taken back. */
export function removeAddedAction(state: AdjudicationState, action_id: string): AdjudicationState {
  return { ...state, added_actions: state.added_actions.filter(entry => entry.action_id !== action_id) };
}

export type ActionAudience = OperatorAssessmentAction["audience"];
export interface AudienceRowsInput { readonly assessment: CurrentAssessment; readonly added_actions: readonly OperatorAddedActionEntry[]; readonly recorded: OperatorAdjudication | null }
export interface ProposedActionRow { readonly action: OperatorAssessmentAction; readonly recorded: OperatorProposedActionEntry | null }
export interface AudienceRows { readonly proposed: readonly ProposedActionRow[]; readonly added: readonly OperatorAddedActionEntry[]; readonly count: number }
/** One audience's list: the assessor's actions with any recorded disposition, then the operator's added ones. */
export function selectAudienceRows({ assessment, added_actions, recorded }: AudienceRowsInput, audience: ActionAudience): AudienceRows {
  const { builder: rework, operator } = selectAssessmentActions(assessment);
  const proposed = { rework, operator }[audience].map(action => ({ action, recorded: recorded?.entries.find(entry => entry.action_id === action.id) ?? null }));
  const added = added_actions.filter(entry => entry.audience === audience);
  return { proposed, added, count: proposed.length + added.length };
}

function selectEntries(state: AdjudicationState): readonly OperatorProposedActionEntry[] {
  return state.assessment.next_actions.flatMap<OperatorProposedActionEntry>(action => {
    const pending = selectPendingDisposition(state, action.id);
    if (!pending) return [];
    const base = { action_id: action.id, original_text: action.text, audience: action.audience, source: action.source };
    if (pending.disposition === "modified") return { ...base, disposition: "modified", final_text: pending.final_text };
    if (pending.disposition === "rejected") return { ...base, disposition: "rejected", ...(pending.reason.trim() ? { reason: pending.reason } : {}) };
    return { ...base, disposition: "accepted" };
  });
}
/** The exact text the reworking worker receives. */
export const selectReworkPreview = (state: AdjudicationState): string => composeReworkFeedback(selectEntries(state), state.added_actions);
/** How many rework actions a send-back delivers. */
export const selectReworkActionCount = (state: AdjudicationState): number =>
  selectEntries(state).filter(entry => entry.audience === "rework" && entry.disposition !== "rejected").length
  + state.added_actions.filter(entry => entry.audience === "rework").length;

export type AdjudicationSendability = { readonly kind: "sendable" } | { readonly kind: "blocked"; readonly reason: string };
export function selectSendability(state: AdjudicationState, role: OperatorAdjudicationRole): AdjudicationSendability {
  if (state.assessment.next_actions.some(action => !selectPendingDisposition(state, action.id))) return { kind: "blocked", reason: "Keep, edit or drop every action." };
  if (state.dispositions.some(entry => entry.disposition === "modified" && !entry.final_text.trim())) return { kind: "blocked", reason: "Edited actions need replacement text." };
  if (state.added_actions.some(entry => !entry.final_text.trim())) return { kind: "blocked", reason: "Added actions need text." };
  const reworkActionCount = selectReworkActionCount(state);
  if (role === "accept" && reworkActionCount > 0) return { kind: "blocked", reason: "Accept sends nothing back. Drop the rework actions, or send them." };
  if (role === "feedback" && reworkActionCount === 0) return { kind: "blocked", reason: "Keep, edit or add at least one rework action." };
  return { kind: "sendable" };
}
export function selectAdjudicationPayload(state: AdjudicationState, decision: ReviewDecisionDefinition): Result<OperatorAdjudication, string> {
  const sendability = selectSendability(state, decision.role);
  return sendability.kind === "blocked" ? { ok: false, error: sendability.reason }
    : { ok: true, value: { entries: selectEntries(state), added_actions: state.added_actions, rework_feedback: selectReworkPreview(state) } };
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
  const isOpen = gate?.actionable === true && selectHandoffRevisionId(gate.assessment_revision_id ?? undefined) === revision && !isRecorded;
  return { revision, recordedDecision, isRecorded, isOpen };
}

export interface ReviewDecisionDefinition { readonly definition: OperatorDecisionDefinition; readonly role: OperatorAdjudicationRole }
/** The gate's declared adjudications, with feedback decisions first. */
export function selectAdjudicationDecisions(gate: ParkedGate | null): readonly ReviewDecisionDefinition[] {
  const adjudicated = (gate?.decision_definitions ?? []).flatMap(definition =>
    isAdjudicationDecision(definition) && definition.adjudication != null ? [{ definition, role: definition.adjudication }] : []);
  return [...adjudicated.filter(({ role }) => role === "feedback"), ...adjudicated.filter(({ role }) => role === "accept")];
}
export type AdjudicationDecision =
  | { readonly kind: "available"; readonly definition: OperatorDecisionDefinition; readonly revision_id: string }
  | { readonly kind: "unavailable"; readonly reason: string };
/** A declared decision submits on the gate's revision, unless the review is gone or its guard does not hold. */
export function selectAdjudicationDecision(gate: ParkedGate | null, decision: ReviewDecisionDefinition): AdjudicationDecision {
  if (!gate?.assessment_revision_id) return { kind: "unavailable", reason: NO_REVIEW_REASON };
  if (decision.definition.is_available === false) return { kind: "unavailable", reason: decision.definition.disabled_reason ?? "Decision unavailable" };
  return { kind: "available", definition: decision.definition, revision_id: gate.assessment_revision_id };
}
/** Why a decision's button is disabled: the pending adjudication first, then the decision's own guard. */
export function selectAdjudicationBlockReason(state: AdjudicationState, gate: ParkedGate | null, decision: ReviewDecisionDefinition): string | null {
  const sendability = selectSendability(state, decision.role);
  if (sendability.kind === "blocked") return sendability.reason;
  const available = selectAdjudicationDecision(gate, decision);
  return available.kind === "unavailable" ? available.reason : null;
}
/** A send-back names how many actions it delivers. */
export const selectDecisionButtonLabel = (state: AdjudicationState, decision: ReviewDecisionDefinition): string =>
  decision.role === "feedback" ? `${decision.definition.label} (${selectReworkActionCount(state)})` : decision.definition.label;
/** One line for a decision already recorded on the displayed revision. */
export const selectRecordedDecisionSummary = (decision: OperatorRevisionDecision): string =>
  `${decision.effect === "approve" ? "Accepted" : "Sent back"} (${decision.decision}) at ${new Date(decision.created_at).toLocaleString()}.`;
