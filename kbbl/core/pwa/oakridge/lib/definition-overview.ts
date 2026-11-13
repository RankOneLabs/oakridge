import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import type { OperatorGroup, OperatorTypeExpression } from "../operator-contracts/core-client/core-types";

export interface DefinitionUnitOverview {
  path: string; key: string; parent: string | null; stage: string | null; is_group: boolean;
  children: string[]; pool: string | null; for_each: string | null; key_expression: string | null; after: string | null;
}
export interface DefinitionPoolOverview { name: string; scope: string | null; capacity: number; units: string[] }
export interface DefinitionOverview {
  name: string; id: string; input: OperatorTypeExpression; outputs: OperatorGroup["outcome"];
  units: DefinitionUnitOverview[]; stages: readonly string[]; pools: DefinitionPoolOverview[];
  collections: DefinitionUnitOverview[]; groups: DefinitionUnitOverview[]; schemas: OperatorDefinitionDetail["bundle"]["schemas"];
}
export function selectDefinitionOverview(detail: OperatorDefinitionDetail): DefinitionOverview {
  const units: DefinitionUnitOverview[] = [];
  const pools: DefinitionPoolOverview[] = [];
  function scan(group: OperatorGroup, parent: string | null, inherited: Map<string, DefinitionPoolOverview>): void {
    const scope = new Map(inherited);
    for (const [name, capacity] of Object.entries(group.pools ?? {})) {
      const pool: DefinitionPoolOverview = { name, scope: parent, capacity, units: [] };
      pools.push(pool); scope.set(name, pool);
    }
    for (const [key, unit] of Object.entries(group.units)) {
      const path = parent ? `${parent}/${key}` : key;
      units.push({ path, key, parent, stage: unit.group ? null : unit.stage ?? null, is_group: Boolean(unit.group),
        children: Object.keys(unit.group?.units ?? {}).map((child) => `${path}/${child}`),
        pool: unit.pool ?? null, for_each: unit.for_each ?? null, key_expression: unit.key ?? null,
        after: typeof unit.after === "string" ? unit.after : null });
      if (unit.pool) scope.get(unit.pool)?.units.push(path);
      if (unit.group) scan(unit.group, path, scope);
    }
  }
  scan(detail.workflow.run, null, new Map());
  return { name: detail.workflow.workflow, id: detail.definition_id, input: detail.workflow.input,
    outputs: detail.workflow.run.outcome, units, stages: detail.bundle.stages, pools,
    collections: units.filter((unit) => unit.for_each !== null), groups: units.filter((unit) => unit.is_group), schemas: detail.bundle.schemas };
}
