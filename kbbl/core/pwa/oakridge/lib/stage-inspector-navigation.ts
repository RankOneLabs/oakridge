import type { DefinitionSelection } from "../../lib/hash";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import { selectDefinitionOverview } from "./definition-overview";
import { definitionStageHref, definitionUnitHref } from "./definition-selection";
import { selectStageNavigation, type StageInspectorModel, type StageNavigationEntry } from "./stage-inspector";

export interface StageNavigationLink {
  label: string;
  href: string;
  isCurrent: boolean;
}
export interface StageInspectorNavigationEntry {
  stage: StageNavigationLink;
  units: StageNavigationLink[];
  isSelected: boolean;
}
export interface StageInspectorNavigation {
  stages: StageInspectorNavigationEntry[];
  groups: StageNavigationLink[];
}
export type StageNavigationOptionKind = "stage" | "unit" | "group";
export interface StageNavigationOption extends StageNavigationLink {
  kind: StageNavigationOptionKind;
}
export interface StageNavigationOptions {
  options: StageNavigationOption[];
  /** Absent when nothing in the navigation is current. */
  selectedHref: string | null;
}
export interface StageInspectorIdentity {
  title: string;
  invokers: StageNavigationLink[];
}

function selectHasMergedStageUnit({ name, units }: StageNavigationEntry): boolean {
  return units.length === 1 && units[0]?.path === name;
}

export function selectStageInspectorNavigation(
  definition: OperatorDefinitionDetail,
  selection: DefinitionSelection | null,
): StageInspectorNavigation {
  const overview = selectDefinitionOverview(definition);
  const selectedUnit = selection?.kind === "unit" ? selection.path : null;
  const selectedStage = selection?.kind === "stage"
    ? selection.stage
    : overview.units.find(unit => unit.path === selectedUnit)?.stage;
  return {
    stages: selectStageNavigation(definition).map(entry => {
      const isMerged = selectHasMergedStageUnit(entry);
      return {
        stage: {
          label: entry.name,
          href: definitionStageHref(overview.id, entry.name),
          isCurrent: (selection?.kind === "stage" && selection.stage === entry.name)
            || (isMerged && selectedUnit === entry.name),
        },
        units: isMerged ? [] : entry.units.map(unit => ({
          label: unit.path,
          href: definitionUnitHref(overview.id, unit.path),
          isCurrent: selectedUnit === unit.path,
        })),
        isSelected: selectedStage === entry.name,
      };
    }),
    groups: overview.groups.map(unit => ({
      label: `${unit.path} (group)`,
      href: definitionUnitHref(overview.id, unit.path),
      isCurrent: selectedUnit === unit.path,
    })),
  };
}

/** Flattens navigation into dropdown options: each stage, then its units, then groups. */
export function selectStageNavigationOptions(navigation: StageInspectorNavigation): StageNavigationOptions {
  const options: StageNavigationOption[] = [
    ...navigation.stages.flatMap(({ stage, units }) => [
      { ...stage, kind: "stage" as const },
      ...units.map(unit => ({ ...unit, kind: "unit" as const })),
    ]),
    ...navigation.groups.map(group => ({ ...group, kind: "group" as const })),
  ];
  return { options, selectedHref: options.find(option => option.isCurrent)?.href ?? null };
}

export function selectStageInspectorIdentity(model: StageInspectorModel | null): StageInspectorIdentity | null {
  if (!model) return null;
  const path = model.selected_unit?.path;
  return {
    title: path && path !== model.name ? `${model.name} · unit ${path}` : model.name,
    invokers: selectHasMergedStageUnit(model) ? [] : model.units.map(unit => ({
      label: unit.path,
      href: definitionUnitHref(model.definition.definition_id, unit.path),
      isCurrent: path === unit.path,
    })),
  };
}
