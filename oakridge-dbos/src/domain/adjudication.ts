import { isActionSource, type ActionSource, type AssessmentBody } from "./assessment";
import type { Result } from "./primitives";
import { composeReworkFeedback } from "./rework-feedback";
import type { AdjudicationRole, DeclaredDecisionEffect, ParsedReviewDecision, ParsedStage, ParsedWorkflow } from "../core-client/core-types";
export { composeReworkFeedback } from "./rework-feedback";

/** Field names mirror schemas.action_disposition/added_action/adjudication in development.yaml. */
export type Disposition = "accepted" | "modified" | "rejected";
export interface ProposedActionEntry {
  readonly action_id: string; readonly disposition: Disposition; readonly original_text: string;
  readonly final_text?: string | null; readonly audience: "rework" | "operator"; readonly source: ActionSource; readonly reason?: string | null;
}
export interface AddedActionEntry {
  readonly action_id: string; readonly origin: "operator"; readonly final_text: string;
  readonly audience: "rework" | "operator"; readonly source: ActionSource; readonly reason?: string | null;
}
export interface Adjudication {
  readonly entries: readonly ProposedActionEntry[]; readonly added_actions: readonly AddedActionEntry[]; readonly rework_feedback: string;
}
export interface AdjudicationError { readonly operation: "validate_adjudication"; readonly entity_id: string; readonly detail: string }
export interface AdjudicationTarget { readonly id: string; readonly body: AssessmentBody }
export interface AdjudicatedReviewDecision { readonly key: string; readonly effect: DeclaredDecisionEffect; readonly adjudication: AdjudicationRole | null; readonly fields: readonly string[] }
export interface AdjudicatedReview {
  readonly assessment_artifact: string;
  readonly decisions: readonly AdjudicatedReviewDecision[];
}
/** Mirrors selectDecisionPayloadType: declared fields, plus conventional feedback on a change request that forwards none. */
const plainFields = (decision: ParsedReviewDecision): string[] =>
  [...Object.keys(decision.fields ?? {}), ...(decision.effect === "request_changes" && decision.feedback_field == null ? ["feedback"] : [])];
export interface ReviewLocation { readonly workflow: ParsedWorkflow; readonly stage: string | null | undefined; readonly review: string }
/** The review a stage declares, when any of its decisions carries an adjudication; null otherwise. */
export function selectAdjudicatedReview({ workflow, stage, review }: ReviewLocation): AdjudicatedReview | null {
  const declared = stage == null ? undefined : workflow.stages[stage]?.reviews?.[review];
  if (declared?.assessment == null) return null;
  const entries = Object.entries(declared.decisions);
  if (!entries.some(([, decision]) => decision.adjudication != null)) return null;
  return { assessment_artifact: declared.assessment,
    decisions: entries.map(([key, decision]) => ({ key, effect: decision.effect, adjudication: decision.adjudication ?? null, fields: plainFields(decision) })) };
}
/** Whether a review binds adjudication decisions to this assessment. */
export const isAdjudicatedArtifact = (stage: ParsedStage, artifact: string): boolean =>
  Object.values(stage.reviews ?? {}).some((review) => review.assessment === artifact && Object.values(review.decisions).some(decision => decision.adjudication != null));
/** The adjudication a recorded decision carries when its declaration has a role. */
export function selectRecordedAdjudication(review: AdjudicatedReview | null, decision: string, payload: unknown): Adjudication | null {
  return review?.decisions.some((declared) => declared.key === decision && declared.adjudication != null) ? parseAdjudication(payload) : null;
}
/** One review decision's adjudication payload, the assessment it targets and the decision's effect. */
export interface AdjudicationRequest { readonly payload: unknown; readonly assessment: AdjudicationTarget; readonly decision: AdjudicatedReviewDecision }
const fields = (value: unknown): value is { readonly [key: string]: unknown } => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const optionalText = (value: unknown): value is string | null | undefined => value == null || text(value);
const audience = (value: unknown) => value === "rework" || value === "operator";
const proposed = (value: unknown): value is ProposedActionEntry => fields(value) && text(value.action_id) && ["accepted", "modified", "rejected"].includes(String(value.disposition))
  && text(value.original_text) && optionalText(value.final_text) && audience(value.audience) && isActionSource(value.source) && optionalText(value.reason);
const added = (value: unknown): value is AddedActionEntry => fields(value) && text(value.action_id) && value.origin === "operator" && text(value.final_text)
  && audience(value.audience) && isActionSource(value.source) && optionalText(value.reason);
export function parseAdjudication(payload: unknown): Adjudication | null {
  if (!fields(payload) || !Array.isArray(payload.entries) || !payload.entries.every(proposed) || !Array.isArray(payload.added_actions) || !payload.added_actions.every(added) || !text(payload.rework_feedback)) return null;
  return payload as unknown as Adjudication;
}
const refuse = (entity_id: string, detail: string): Result<never, AdjudicationError> => ({ ok: false, error: { operation: "validate_adjudication", entity_id, detail } });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sameSource = (left: ActionSource, right: ActionSource) => left.kind === right.kind && left.id === right.id;

/** Entries are canonicalized to next_actions order before composing; wire order never changes the send. */
export function validateAdjudication({ payload, assessment, decision }: AdjudicationRequest): Result<Adjudication | null, AdjudicationError> {
  if (decision.adjudication == null) return payload == null || (typeof payload === "object" && Object.keys(payload).every((key) => decision.fields.includes(key)))
    ? { ok: true, value: null } : refuse(assessment.id, `${decision.key} does not accept adjudication`);
  const adjudication = parseAdjudication(payload);
  if (!adjudication) {
    const invalid = fields(payload) ? [...(Array.isArray(payload.entries) ? payload.entries.filter(entry => !proposed(entry)) : []),
      ...(Array.isArray(payload.added_actions) ? payload.added_actions.filter(entry => !added(entry)) : [])][0] : null;
    return refuse(fields(invalid) && text(invalid.action_id) ? invalid.action_id : assessment.id, "invalid adjudication payload");
  }
  const actions = assessment.body.next_actions;
  for (const entry of adjudication.entries) {
    const action = actions.find((action) => action.id === entry.action_id);
    if (!action) return refuse(entry.action_id, "action is not in the target revision");
    if (entry.original_text !== action.text || entry.audience !== action.audience || !sameSource(entry.source, action.source)) return refuse(entry.action_id, "original_text, audience and source must match the target action");
    if (entry.disposition === "modified" && !entry.final_text?.trim()) return refuse(entry.action_id, "modified action requires non-empty final_text");
    if (entry.disposition === "accepted" && entry.final_text != null && entry.final_text !== action.text) return refuse(entry.action_id, "accepted final_text must equal original_text");
  }
  for (const action of actions) {
    if (adjudication.entries.filter((entry) => entry.action_id === action.id).length !== 1) return refuse(action.id, "every target action requires exactly one entry");
  }
  const addedIds = new Set<string>();
  for (const entry of adjudication.added_actions) {
    if (!uuid.test(entry.action_id) || addedIds.has(entry.action_id) || actions.some((action) => action.id === entry.action_id)) return refuse(entry.action_id, "added action id must be a unique UUID distinct from assessor actions");
    addedIds.add(entry.action_id);
    const resolves = entry.source.kind === "item_assessment" ? assessment.body.item_assessments.some((item) => item.subject.id === entry.source.id)
      : assessment.body.additional_findings.some((finding) => finding.id === entry.source.id);
    if (!resolves) return refuse(entry.action_id, "added action source does not resolve in the target revision");
    if (!entry.final_text.trim()) return refuse(entry.action_id, "added action requires non-empty final_text");
  }
  const ordered = actions.flatMap((action) => adjudication.entries.filter((entry) => entry.action_id === action.id));
  const feedback = composeReworkFeedback(ordered, adjudication.added_actions);
  if (decision.adjudication === "accept" && (ordered.some(entry => entry.audience === "rework" && entry.disposition !== "rejected")
    || adjudication.added_actions.some(entry => entry.audience === "rework"))) {
    return refuse(assessment.id, "accept cannot keep rework actions; drop them or send them");
  }
  if (decision.adjudication === "feedback" && !feedback.trim()) return refuse(assessment.id, "feedback requires non-empty rework_feedback");
  if (adjudication.rework_feedback !== feedback) return refuse(assessment.id, "rework_feedback differs from composeReworkFeedback");
  return { ok: true, value: adjudication };
}

/** The core redirects an adjudicated send-back to its `on` artifact. The reviewed assessment
 * is resolved from immutable revision history under the same lock (or as of the event). */
export interface AssessmentReviewReference { readonly review: string; readonly unit_id: string; readonly target_revision_id: string; readonly created_at?: Date }
export interface AssessmentReviewRevision { readonly id: string; readonly unit_id: string; readonly artifact: string; readonly seq: number; readonly created_at?: Date }
export interface AssessmentReviewResolution { readonly decision: AssessmentReviewReference; readonly review: AdjudicatedReview | null; readonly revisions: readonly AssessmentReviewRevision[] }
export function selectReviewedAssessmentId({ decision, review, revisions }: AssessmentReviewResolution): string | null {
  if (!review) return null;
  const target = revisions.find(revision => revision.id === decision.target_revision_id && revision.unit_id === decision.unit_id);
  if (target?.artifact === review.assessment_artifact) return target.id;
  if (!target) return null;
  return revisions.filter(revision => revision.unit_id === decision.unit_id && revision.artifact === review.assessment_artifact
    && (!decision.created_at || !revision.created_at || revision.created_at <= decision.created_at))
    .sort((left, right) => right.seq - left.seq)[0]?.id ?? null;
}
