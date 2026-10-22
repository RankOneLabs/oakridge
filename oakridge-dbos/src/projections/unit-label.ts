import { ROOT_DECLARATION, type Workflow } from "../core-client/core-types";

/** The core's declaration of a run's root unit; its unit key. */
export const ROOT_UNIT_KEY = ROOT_DECLARATION;

/** `spec_analysis` -> `Spec Analysis`. */
export const titleCase = (key: string): string =>
  key.split(/[_\-\s]+/).filter((word) => word.length > 0).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

/** What a unit's keys and label derive from: its id below its parent, its declaration and its stage. */
export interface LabelledUnit { readonly id: string; readonly parent_id: string | null; readonly declaration: string; readonly stage: string | null; readonly collection_key?: string | null }

/** A unit's key is the declaration it was materialized from. */
export const selectUnitKey = (unit: Pick<LabelledUnit, "declaration">): string => unit.declaration;

type TreeUnit = Pick<LabelledUnit, "id" | "parent_id" | "declaration">;
/** A run's units by id, with the pinned workflow they were materialized from. */
export interface UnitTree { readonly units: ReadonlyMap<string, TreeUnit>; readonly workflow: Pick<Workflow, "workflow" | "run"> }
export const selectUnitTree = (units: readonly TreeUnit[], workflow: Pick<Workflow, "workflow" | "run">): UnitTree =>
  ({ units: new Map(units.map((unit) => [unit.id, unit])), workflow });

/** Core emits the collection key when it materializes the unit. */
export const selectCollectionKey = (unit: Pick<LabelledUnit, "collection_key">): string | null => unit.collection_key ?? null;

/**
 * A unit's operator label (rescue spec §3.1): its unit key title-cased, the
 * stage key for a collection member, and the workflow's name for the root.
 */
export function selectUnitLabel(unit: LabelledUnit, tree: UnitTree): string {
  if (selectUnitKey(unit) === ROOT_UNIT_KEY) return titleCase(tree.workflow.workflow);
  return titleCase(selectCollectionKey(unit) !== null && unit.stage !== null ? unit.stage : selectUnitKey(unit));
}
