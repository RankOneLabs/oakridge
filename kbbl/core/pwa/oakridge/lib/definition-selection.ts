import type { DefinitionSelection } from "../../lib/hash";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import type { OperatorGroup, OperatorUnit } from "../operator-contracts/core-client/core-types";

export function definitionHref(id: string): string { return `#settings/workflows/${encodeURIComponent(id)}`; }
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


export type EffectiveDefinitionSelection = DefinitionSelection | null;
/** Preserve explicit routes, including missing declarations; default without changing history. */
export function selectEffectiveDefinitionSelection(
  definition: OperatorDefinitionDetail,
  selection: DefinitionSelection | null,
): EffectiveDefinitionSelection {
  const first = definition.bundle.stages[0];
  return selection ?? (first ? { kind: "stage", stage: first, tab: null } : null);
}

export type StageTab = "overview" | "inputs" | "bindings" | "workers" | "prompts" | "artifacts" | "reviews" | "completion";
export const STAGE_TABS: readonly { value: StageTab; label: string }[] = [
  { value: "overview", label: "Overview" }, { value: "inputs", label: "Inputs" },
  { value: "bindings", label: "Bindings" }, { value: "workers", label: "Workers" },
  { value: "prompts", label: "Prompts" }, { value: "artifacts", label: "Artifacts" },
  { value: "reviews", label: "Reviews" }, { value: "completion", label: "Completion" },
];
export function definitionTabHref(id: string, selection: DefinitionSelection, tab: StageTab): string {
  const clean = selection.kind === "stage" ? { ...selection, stage: selection.stage.split("#")[0] ?? "" } : { ...selection, path: selection.path.split("#")[0] ?? "" };
  return definitionSelectionHref(id, clean).replace(definitionHref(id), `${definitionHref(id)}/tabs/${tab}`);
}
export function selectTabForAnchor(stage: string, anchor: string | null | undefined): StageTab | null {
  const prefix = `stage-${encodeURIComponent(stage)}-`;
  if (!anchor?.startsWith(prefix)) return null;
  const suffix = anchor.slice(prefix.length);
  const kinds: readonly [string, StageTab][] = [
    ["worker-input", "workers"], ["template-worker", "prompts"], ["template-review", "prompts"],
    ["decision-set", "prompts"], ["prompt", "prompts"], ["let", "bindings"], ["worker", "workers"],
    ["artifact", "artifacts"], ["review", "reviews"], ["outcome", "completion"],
  ];
  return kinds.find(([kind]) => suffix.startsWith(kind + "-"))?.[1] ?? null;
}
export function selectEffectiveStageTab(selection: DefinitionSelection | null, anchor?: string | null): StageTab {
  const stage = selection?.kind === "stage" ? selection.stage.split("#")[0] ?? "" : "";
  return selection?.tab ?? selectTabForAnchor(stage, anchor) ?? "overview";
}
export function selectDefinitionStructureSummary(overview: import("./definition-overview").DefinitionOverview): string {
  return ([["stage", overview.stages.length], ["unit", overview.units.length], ["group", overview.groups.length], ["collection", overview.collections.length], ["pool", overview.pools.length]] as const)
    .map(([noun, count]) => `${count} ${noun}${count === 1 ? "" : "s"}`).join(" · ");
}
