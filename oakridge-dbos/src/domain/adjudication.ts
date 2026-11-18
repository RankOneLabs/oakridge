import { z } from "zod";
import { actionSourceSchema, type ActionSource, type AssessmentBody } from "./assessment";
import type { Result } from "./primitives";
import { composeBuilderFeedback } from "./builder-feedback";
export { composeBuilderFeedback } from "./builder-feedback";

/** Field names mirror schemas.action_disposition/added_action/adjudication in development.yaml. */
export type Disposition = "accepted" | "modified" | "rejected";
export interface ProposedActionEntry {
  readonly action_id: string; readonly disposition: Disposition; readonly original_text: string;
  readonly final_text?: string | null; readonly audience: "builder" | "operator"; readonly source: ActionSource; readonly reason?: string | null;
}
export interface AddedActionEntry {
  readonly action_id: string; readonly origin: "operator"; readonly final_text: string;
  readonly audience: "builder" | "operator"; readonly source: ActionSource; readonly reason?: string | null;
}
export interface Adjudication {
  readonly entries: readonly ProposedActionEntry[]; readonly added_actions: readonly AddedActionEntry[]; readonly builder_feedback: string;
}
export interface AdjudicationError { readonly operation: "validate_adjudication"; readonly entity_id: string; readonly detail: string }
export interface AdjudicationTarget { readonly id: string; readonly body: AssessmentBody }
export type AdjudicationEffect = "accept" | "request_build_changes" | "request_changes" | "request_assessment_changes";
const common = { action_id: z.string(), audience: z.enum(["builder", "operator"]), source: actionSourceSchema, reason: z.string().nullish() };
export const adjudicationSchema: z.ZodType<Adjudication> = z.object({
  entries: z.array(z.object({ ...common, disposition: z.enum(["accepted", "modified", "rejected"]), original_text: z.string(), final_text: z.string().nullish() }).strict()),
  added_actions: z.array(z.object({ ...common, origin: z.literal("operator"), final_text: z.string() }).strict()), builder_feedback: z.string(),
}).strict();
export function parseAdjudication(payload: unknown): Adjudication | null {
  const parsed = adjudicationSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
const refuse = (entity_id: string, detail: string): Result<never, AdjudicationError> => ({ ok: false, error: { operation: "validate_adjudication", entity_id, detail } });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sameSource = (left: ActionSource, right: ActionSource) => left.kind === right.kind && left.id === right.id;

/** Entries are canonicalized to next_actions order before composing; wire order never changes the send. */
export function validateAdjudication(payload: unknown, assessment: AdjudicationTarget, effect: AdjudicationEffect): Result<Adjudication | null, AdjudicationError> {
  if (effect === "request_assessment_changes") return payload == null || (typeof payload === "object" && Object.keys(payload).every((key) => key === "feedback"))
    ? { ok: true, value: null } : refuse(assessment.id, "request_assessment_changes does not accept adjudication");
  const parsed = adjudicationSchema.safeParse(payload);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path;
    const collection = path?.[0] === "entries" || path?.[0] === "added_actions" ? path[0] : null;
    const candidate = collection && typeof path?.[1] === "number" && payload && typeof payload === "object"
      ? (payload as { entries?: ProposedActionEntry[]; added_actions?: AddedActionEntry[] })[collection]?.[path[1]] : null;
    return refuse(candidate?.action_id ?? assessment.id, `invalid adjudication: ${parsed.error.message}`);
  }
  const adjudication = parsed.data;
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
  const feedback = composeBuilderFeedback(ordered, adjudication.added_actions);
  if ((effect === "request_build_changes" || effect === "request_changes") && !feedback.trim()) return refuse(assessment.id, "request changes requires non-empty builder_feedback");
  if (adjudication.builder_feedback !== feedback) return refuse(assessment.id, "builder_feedback differs from composeBuilderFeedback");
  return { ok: true, value: adjudication };
}
