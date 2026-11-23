import type { CurrentBrief, CurrentCohort, CanonicalSpec } from "./viewer-data";
import type { SubnavSection } from "./artifact-subnav";
export const selectCurrentBuildItems = (brief: CurrentBrief) => brief.build_items.map((item) => ({ ...item,
  decisions: brief.technical_decisions.filter((decision) => decision.build_item_ids.includes(item.id)),
}));
export const selectAllocations = (cohort: CurrentCohort, spec: CanonicalSpec | null) => cohort.allocations.map((allocation) => ({ ...allocation,
  requirement: spec?.requirements.find((requirement) => requirement.id === allocation.requirement_id) ?? null,
}));

export type BriefSection = "build_items" | "files" | "envelope";
/** The current brief viewer's subnav: authored build items first, then files in scope, then the plan-bound envelope. */
export const selectBriefSections = (brief: CurrentBrief): readonly SubnavSection<BriefSection>[] => [
  { value: "build_items", label: "Build items", count: brief.build_items.length },
  { value: "files", label: "Files in scope", count: brief.files_in_scope.length },
  { value: "envelope", label: "Envelope", count: null },
];
