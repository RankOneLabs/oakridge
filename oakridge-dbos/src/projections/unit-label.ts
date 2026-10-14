import type { Workflow } from "../core-client/core-types";

/** The core's declaration of a run's root unit; its unit key. */
export const ROOT_UNIT_KEY = "$root";

/** `spec_analysis` -> `Spec Analysis`. */
export const titleCase = (key: string): string =>
  key.split(/[_\-\s]+/).filter((word) => word.length > 0).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

/** What a unit's keys and label derive from: its id below its parent, its declaration and its stage. */
export interface LabelledUnit { readonly id: string; readonly parent_id: string | null; readonly declaration: string; readonly stage: string | null }

/** A unit's key is the declaration it was materialized from. */
export const selectUnitKey = (unit: Pick<LabelledUnit, "declaration">): string => unit.declaration;

/** A collection member's key is its id below its parent; a fixed unit (and the root) has none. */
export function selectCollectionKey(unit: Pick<LabelledUnit, "id" | "parent_id" | "declaration">): string | null {
  if (unit.parent_id === null) return null;
  const member = unit.id.slice(unit.parent_id.length + 1);
  return member === unit.declaration ? null : member;
}

/**
 * A unit's operator label (rescue spec §3.1): its unit key title-cased, the
 * stage key for a collection member, and the workflow's name for the root.
 */
export function selectUnitLabel(unit: LabelledUnit, workflow: Pick<Workflow, "workflow">): string {
  if (selectUnitKey(unit) === ROOT_UNIT_KEY) return titleCase(workflow.workflow);
  return titleCase(selectCollectionKey(unit) !== null && unit.stage !== null ? unit.stage : selectUnitKey(unit));
}
