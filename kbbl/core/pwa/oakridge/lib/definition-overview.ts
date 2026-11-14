import type { DefinitionSelection } from "../../lib/hash";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import type {
  OperatorGroup,
  OperatorTypeExpression,
  OperatorUnit,
} from "../operator-contracts/core-client/core-types";

export interface DefinitionUnitOverview {
  path: string;
  key: string;
  parent: string | null;
  stage: string | null;
  is_group: boolean;
  children: string[];
  pool: string | null;
  for_each: string | null;
  key_expression: string | null;
  after: NonNullable<OperatorUnit["after"]> | null;
  after_text: string | null;
  has_per_member_after: boolean;
  input: OperatorUnit["input"];
}
export interface DefinitionPoolOverview {
  name: string;
  scope: string | null;
  capacity: number;
  units: string[];
}
export interface DefinitionOverview {
  name: string;
  id: string;
  input: OperatorTypeExpression;
  outputs: OperatorGroup["outcome"];
  units: DefinitionUnitOverview[];
  stages: readonly string[];
  pools: DefinitionPoolOverview[];
  collections: DefinitionUnitOverview[];
  groups: DefinitionUnitOverview[];
  schemas: OperatorDefinitionDetail["bundle"]["schemas"];
}
const ABBREVIATED_DEFINITION_ID_LENGTH = 12;
/** Compact header form of a definition id; the full id stays available through copy and title. */
export function selectAbbreviatedDefinitionId(id: string): string {
  return `${id.slice(0, ABBREVIATED_DEFINITION_ID_LENGTH)}…`;
}
export function selectDefinitionOverview(detail: OperatorDefinitionDetail): DefinitionOverview {
  const units: DefinitionUnitOverview[] = [];
  const pools: DefinitionPoolOverview[] = [];
  function scan(
    group: OperatorGroup,
    parent: string | null,
    inherited: Map<string, DefinitionPoolOverview>,
  ): void {
    const scope = new Map(inherited);
    for (const [name, capacity] of Object.entries(group.pools ?? {})) {
      const pool: DefinitionPoolOverview = { name, scope: parent, capacity, units: [] };
      pools.push(pool);
      scope.set(name, pool);
    }
    for (const [key, unit] of Object.entries(group.units)) {
      const path = parent ? `${parent}/${key}` : key;
      units.push({
        has_per_member_after: typeof unit.after === "string",
        input: unit.input,
        path,
        key,
        parent,
        stage: unit.group ? null : (unit.stage ?? null),
        is_group: Boolean(unit.group),
        children: Object.keys(unit.group?.units ?? {}).map((child) => `${path}/${child}`),
        pool: unit.pool ?? null,
        for_each: unit.for_each ?? null,
        key_expression: unit.key ?? null,
        after: unit.after ?? null,
        after_text: selectDefinitionAfterText(unit.after ?? null),
      });
      if (unit.pool) scope.get(unit.pool)?.units.push(path);
      if (unit.group) scan(unit.group, path, scope);
    }
  }
  scan(detail.workflow.run, null, new Map());
  return {
    name: detail.workflow.workflow,
    id: detail.definition_id,
    input: detail.workflow.input,
    outputs: detail.workflow.run.outcome,
    units,
    stages: detail.bundle.stages,
    pools,
    collections: units.filter((unit) => unit.for_each !== null),
    groups: units.filter((unit) => unit.is_group),
    schemas: detail.bundle.schemas,
  };
}

/** Preserve the authored prerequisite form and give all consumers the same readable text. */
export function selectDefinitionAfterText(after: DefinitionUnitOverview["after"]): string | null {
  if (after === null) return null;
  return typeof after === "string" ? after : JSON.stringify(after);
}

export type DefinitionSelectionDetailState =
  | { kind: "none" }
  | { kind: "missing"; selection: DefinitionSelection }
  | { kind: "stage"; stage: string; callers: DefinitionUnitOverview[] }
  | { kind: "unit"; unit: DefinitionUnitOverview };

interface DefinitionSelectionInput {
  overview: DefinitionOverview;
  selection: DefinitionSelection | null;
}

export function selectDefinitionSelection({
  overview,
  selection,
}: DefinitionSelectionInput): DefinitionSelectionDetailState {
  if (selection === null) return { kind: "none" };
  if (selection.kind === "stage") {
    if (!overview.stages.includes(selection.stage)) return { kind: "missing", selection };
    return {
      kind: "stage",
      stage: selection.stage,
      callers: overview.units.filter((unit) => unit.stage === selection.stage),
    };
  }
  const unit = overview.units.find((unit) => unit.path === selection.path);
  return unit ? { kind: "unit", unit } : { kind: "missing", selection };
}

export type DefinitionSchemaPart = { kind: "text"; text: string } | { kind: "schema"; text: string };

export function selectDefinitionSchemaParts(
  text: string,
  schemas: DefinitionOverview["schemas"],
): DefinitionSchemaPart[] {
  const names = new Set(schemas.map((schema) => schema.key));
  return text
    .split(/([A-Za-z_][A-Za-z_0-9]*)/)
    .filter((part) => part.length > 0)
    .map((part) => ({ kind: names.has(part) ? "schema" : "text", text: part }));
}
