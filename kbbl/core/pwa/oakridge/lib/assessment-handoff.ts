import type { Assessment } from "./assessment";

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
