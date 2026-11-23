import type { ObservationAddressedItem } from "../grading-contracts/grading/item-reads";
/** Tasks and contributions declare their spec task directly; a finding's own id is never a task link. */
export function selectSpecTaskId(item: Pick<ObservationAddressedItem, "item_kind" | "selected_value">): string | null {
  if (item.item_kind !== "task" && item.item_kind !== "acceptance_entry") return null;
  const id = (item.selected_value as { readonly id?: unknown } | null)?.id;
  return typeof id === "string" && id.trim() !== "" ? id : null;
}
