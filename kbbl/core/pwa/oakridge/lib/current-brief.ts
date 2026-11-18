import type { CurrentBrief, CurrentCohort, CanonicalSpec } from "./current-contract";
export const selectCurrentBuildItems = (brief: CurrentBrief) => brief.build_items.map((item) => ({ ...item,
  decisions: brief.technical_decisions.filter((decision) => decision.build_item_ids.includes(item.id)),
}));
export const selectAllocations = (cohort: CurrentCohort, spec: CanonicalSpec | null) => cohort.allocations.map((allocation) => ({ ...allocation,
  requirement: spec?.requirements.find((requirement) => requirement.id === allocation.requirement_id) ?? null,
}));
