import type { ObservationAddressedItem, ObservationCompositeRead } from "../grading-contracts/grading/item-reads";
import type { RunIdentityRollup } from "./tasks";
/** Tasks and contributions declare their spec task directly; a finding's own id is never a task link. */
export function selectSpecTaskId(item: Pick<ObservationAddressedItem, "item_kind" | "selected_value">): string | null {
  if (item.item_kind !== "task" && item.item_kind !== "acceptance_entry") return null;
  const id = (item.selected_value as { readonly id?: unknown } | null)?.id;
  return typeof id === "string" && id.trim() !== "" ? id : null;
}


export interface RequirementGradingRow { readonly id: string; readonly text: string; readonly composite: ObservationCompositeRead | null }
export interface RequirementGradingInput { readonly identity: RunIdentityRollup; readonly composites: readonly ObservationCompositeRead[]; readonly page: import("../grading-contracts/grading/composite").ObservationPageRequest }
/** Page canonical identities, then join each displayed row against the complete grading read. */
export function selectRequirementGradingRows({ identity, composites, page }: RequirementGradingInput): import("../grading-contracts/grading/composite").ObservationPaged<RequirementGradingRow> {
  const rows = identity.label === "Requirements" ? identity.rows : [];
  const grades = new Map(composites.map((composite) => [composite.producer_local_id, composite]));
  return { ...page, total: rows.length, items: rows.slice(page.offset, page.offset + page.limit).map((requirement) => ({
    id: requirement.id, text: requirement.description, composite: grades.get(requirement.id) ?? null,
  })) };
}
