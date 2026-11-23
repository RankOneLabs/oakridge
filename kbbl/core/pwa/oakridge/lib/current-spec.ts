import type { CanonicalSpec } from "./viewer-data";
import type { SubnavSection } from "./artifact-subnav";

export type SpecSection = "requirements" | "non_goals" | "original_input";
/** The canonical specification viewer's subnav, requirements first. */
export const selectSpecSections = (spec: CanonicalSpec): readonly SubnavSection<SpecSection>[] => [
  { value: "requirements", label: "Requirements", count: spec.requirements.length },
  { value: "non_goals", label: "Non-goals", count: spec.non_goals.length },
  { value: "original_input", label: "Original input", count: null },
];
