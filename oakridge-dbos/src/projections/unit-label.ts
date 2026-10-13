import type { Workflow } from "../core-client/core-types";

/** The core's declaration of a run's root unit; its unit key. */
export const ROOT_UNIT_KEY = "$root";

/** `spec_analysis` -> `Spec Analysis`. */
export const titleCase = (key: string): string =>
  key.split(/[_\-\s]+/).filter((word) => word.length > 0).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

export interface LabelledUnit { readonly unit_key: string; readonly collection_key: string | null; readonly stage: string | null }
/**
 * A unit's operator label (rescue spec §3.1): its unit key title-cased, the
 * stage key for a collection member, and the workflow's name for the root.
 */
export function selectUnitLabel(unit: LabelledUnit, workflow: Pick<Workflow, "workflow">): string {
  if (unit.unit_key === ROOT_UNIT_KEY) return titleCase(workflow.workflow);
  return titleCase(unit.collection_key !== null && unit.stage !== null ? unit.stage : unit.unit_key);
}
