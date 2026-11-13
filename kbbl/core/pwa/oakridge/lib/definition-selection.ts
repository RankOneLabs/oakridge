import type { DefinitionSelection } from "../../lib/hash";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import type { OperatorGroup, OperatorUnit } from "../operator-contracts/core-client/core-types";

export function definitionHref(id: string): string { return `#oakridge/defs/${encodeURIComponent(id)}`; }
export function definitionStageHref(id: string, stage: string): string { return `${definitionHref(id)}/stages/${encodeURIComponent(stage)}`; }
export function definitionUnitHref(id: string, path: string): string { return `${definitionHref(id)}/units/${path.split("/").map(encodeURIComponent).join("/")}`; }
export function definitionSelectionHref(id: string, selection: DefinitionSelection | null): string {
  if (!selection) return definitionHref(id);
  return selection.kind === "stage" ? definitionStageHref(id, selection.stage) : definitionUnitHref(id, selection.path);
}
export function definitionSchemaElementId(name: string): string { return `definition-schema-${encodeURIComponent(name)}`; }
export function selectDefinitionUnit(group: OperatorGroup, path: string): OperatorUnit | null {
  const [key, ...rest] = path.split("/");
  const unit = key ? group.units[key] : null;
  if (!unit) return null;
  if (rest.length === 0) return unit;
  return unit.group ? selectDefinitionUnit(unit.group, rest.join("/")) : null;
}
export function selectDefinitionSlice(workflow: OperatorDefinitionDetail["workflow"] | OperatorDefinitionDetail["effective_workflow"], selection: DefinitionSelection | null): unknown | null {
  if (!selection) return null;
  return selection.kind === "stage" ? workflow.stages[selection.stage] ?? null : selectDefinitionUnit(workflow.run, selection.path);
}
