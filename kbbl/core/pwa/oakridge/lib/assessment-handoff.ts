import type { Assessment } from "./assessment";
import type { ParkedGate } from "../types";

/** One editable recommendation from the registered assessment body. */
export interface HandoffItem {
  readonly index: number;
  readonly text: string;
  readonly is_included: boolean;
}

export function selectHandoffItems(assessment: Assessment): HandoffItem[] {
  return assessment.recommended_next_actions.map((text, index) => ({ index, text, is_included: true }));
}

/** The exact prompt shown in the preview and sent to the builder. */
export function composeHandoffText(items: readonly HandoffItem[]): string {
  const included = items.filter((item) => item.is_included);
  if (included.length === 0) return "";
  return `Recommended next actions for the builder:\n\n${included.map((item, index) => `${index + 1}. ${item.text}`).join("\n")}`;
}

/** Publish a successor assessment with one recommendation removed. */
export function withItemRemoved(body: Assessment, index: number): Assessment {
  return {
    ...body,
    recommended_next_actions: body.recommended_next_actions.filter((_, itemIndex) => itemIndex !== index),
  };
}

/** Publish a successor assessment with one recommendation appended. */
export function withItemAdded(body: Assessment, text: string): Assessment {
  return { ...body, recommended_next_actions: [...body.recommended_next_actions, text] };
}

/** What the send control offers: the open review to send on, a send already recorded, or no review to send on. */
export type HandoffSendTarget =
  | { readonly kind: "review"; readonly gate: ParkedGate }
  | { readonly kind: "sent" }
  | { readonly kind: "no_review" };

/** A recorded send stays shown until a different review opens, which the assessor's next assessment brings. */
export function selectHandoffSendTarget(gate: ParkedGate | null, sent_gate_id: string | null): HandoffSendTarget {
  if (gate !== null && gate.id !== sent_gate_id) return { kind: "review", gate };
  if (sent_gate_id !== null) return { kind: "sent" };
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
  return { kind: "sendable", artifact_revision_id: gate.artifact_revision_id };
}
