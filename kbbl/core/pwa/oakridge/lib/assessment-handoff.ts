import type { Assessment, NextAction } from "./assessment";
import type { Result } from "../../lib/result";

export type AssessmentPublication = Omit<Assessment, "recommended_next_actions"> & {
  readonly recommended_next_actions: readonly (NextAction | { readonly text: string })[];
};
import type { ParkedGate } from "../types";
import { REQUEST_BUILD_CHANGES } from "../adapters/core";

/** One editable recommendation from the registered assessment body. */
export interface HandoffItem {
  readonly id: string;
  readonly text: string;
  readonly is_included: boolean;
}

export function selectHandoffItems(assessment: Assessment): HandoffItem[] {
  return assessment.recommended_next_actions.flatMap((action) => typeof action === "string" ? []
    : [{ id: action.id, text: action.text, is_included: true }]);
}
export const hasHandoffItem = (assessment: Assessment, id: string): boolean => assessment.recommended_next_actions
  .some((action) => typeof action !== "string" && action.id === id);

/** The exact prompt shown in the preview and sent to the builder. */
export function composeHandoffText(items: readonly HandoffItem[]): string {
  const included = items.filter((item) => item.is_included);
  if (included.length === 0) return "";
  return `Recommended next actions for the builder:\n\n${included.map((item, index) => `${index + 1}. ${item.text}`).join("\n")}`;
}

/** Publish a successor assessment with one recommendation removed. */
export function withItemRemoved(body: Assessment, id: string): Result<Assessment, string> {
  if (body.recommended_next_actions.some((action) => typeof action === "string"))
    return { ok: false, error: "Historical actions cannot be edited." };
  if (!hasHandoffItem(body, id)) return { ok: false, error: "Action is absent from the current assessment. Refresh and review it again." };
  return { ok: true, value: {
    ...body,
    recommended_next_actions: body.recommended_next_actions.filter((action) => typeof action !== "string" && action.id !== id),
  } };
}

/** Publish a successor assessment with one recommendation appended. */
export function withItemAdded(body: Assessment, text: string): AssessmentPublication {
  return { ...body, recommended_next_actions: [...body.recommended_next_actions.filter((action): action is NextAction => typeof action !== "string"), { text }] };
}
export function withItemTextChanged(body: Assessment, id: string, text: string): Assessment {
  return { ...body, recommended_next_actions: body.recommended_next_actions.map((action) =>
    typeof action !== "string" && action.id === id ? { ...action, text } : action) };
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
