import type { ObservationAddressedItem, ObservationCompositeRead } from "../grading-contracts/grading/item-reads";
import type { RunIdentityRollup } from "./tasks";
/** Tasks and contributions declare their spec task directly; a finding's own id is never a task link. */
export function selectSpecTaskId(item: Pick<ObservationAddressedItem, "item_kind" | "selected_value">): string | null {
  if (item.item_kind !== "task" && item.item_kind !== "acceptance_entry") return null;
  const id = (item.selected_value as { readonly id?: unknown } | null)?.id;
  return typeof id === "string" && id.trim() !== "" ? id : null;
}


export interface RequirementGradingRow { readonly id: string; readonly text: string; readonly composite: ObservationCompositeRead | null }
/** Requirement identity and text come from spec; observations supply grading only. */
export const selectRequirementGradingRows = (identity: RunIdentityRollup, composites: readonly ObservationCompositeRead[]): readonly RequirementGradingRow[] =>
  identity.label === "Requirements" ? identity.rows.map((requirement) => ({ id: requirement.id, text: requirement.description,
    composite: composites.find((composite) => composite.producer_local_id === requirement.id) ?? null,
  })) : [];
