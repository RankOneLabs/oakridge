import type { Group, Workflow } from "../core-client/core-types";

/** The core's declaration of a run's root unit; its unit key. */
export const ROOT_UNIT_KEY = "$root";

/** `spec_analysis` -> `Spec Analysis`. */
export const titleCase = (key: string): string =>
  key.split(/[_\-\s]+/).filter((word) => word.length > 0).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

/** What a unit's keys and label derive from: its id below its parent, its declaration and its stage. */
export interface LabelledUnit { readonly id: string; readonly parent_id: string | null; readonly declaration: string; readonly stage: string | null }

/** A unit's key is the declaration it was materialized from. */
export const selectUnitKey = (unit: Pick<LabelledUnit, "declaration">): string => unit.declaration;

type TreeUnit = Pick<LabelledUnit, "id" | "parent_id" | "declaration">;
/** A run's units by id, with the pinned workflow they were materialized from. */
export interface UnitTree { readonly units: ReadonlyMap<string, TreeUnit>; readonly workflow: Pick<Workflow, "workflow" | "run"> }
export const selectUnitTree = (units: readonly TreeUnit[], workflow: Pick<Workflow, "workflow" | "run">): UnitTree =>
  ({ units: new Map(units.map((unit) => [unit.id, unit])), workflow });

/** The group a unit's children are declared in: the workflow's run for the root, its own declaration's group below it. */
function selectDeclaredGroup(unit_id: string, tree: UnitTree): Group | null {
  const unit = tree.units.get(unit_id);
  if (!unit) return null;
  if (unit.parent_id === null) return tree.workflow.run;
  const group = selectDeclaredGroup(unit.parent_id, tree);
  return group && Object.hasOwn(group.units, unit.declaration) ? group.units[unit.declaration]?.group ?? null : null;
}

/**
 * A collection member's key is its id below its parent. Membership comes from
 * the declaration's `for_each`, not the id: a member may share its declaration's name.
 */
export function selectCollectionKey(unit: TreeUnit, tree: UnitTree): string | null {
  if (unit.parent_id === null) return null;
  const group = selectDeclaredGroup(unit.parent_id, tree);
  const declared = group && Object.hasOwn(group.units, unit.declaration) ? group.units[unit.declaration] : undefined;
  return declared?.for_each ? unit.id.slice(unit.parent_id.length + 1) : null;
}

/**
 * A unit's operator label (rescue spec §3.1): its unit key title-cased, the
 * stage key for a collection member, and the workflow's name for the root.
 */
export function selectUnitLabel(unit: LabelledUnit, tree: UnitTree): string {
  if (selectUnitKey(unit) === ROOT_UNIT_KEY) return titleCase(tree.workflow.workflow);
  return titleCase(selectCollectionKey(unit, tree) !== null && unit.stage !== null ? unit.stage : selectUnitKey(unit));
}
