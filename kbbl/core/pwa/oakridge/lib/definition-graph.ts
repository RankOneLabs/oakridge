import type { DefinitionSelection } from "../../lib/hash";
import type { DefinitionOverview, DefinitionUnitOverview } from "./definition-overview";
import type { DefinitionDependencies, DependencyEdge } from "./definition-dependencies";
import { selectGraphLayout, type GraphLayout } from "./graph-layout";

interface DefinitionGraphInput {
  overview: DefinitionOverview;
  dependencies: DefinitionDependencies;
  selection: DefinitionSelection | null;
}
interface DefinitionGraphBreadcrumb {
  name: string;
  path: string;
}
export type DefinitionGraphEdge = DependencyEdge & { offset_x: number };

/** Parallel kinds must remain visibly distinct even though Dagre routes one path per pair. */
function selectGraphEdges(edges: DependencyEdge[]): DefinitionGraphEdge[] {
  const kinds = new Map<string, Set<DependencyEdge["kind"]>>();
  for (const edge of edges) {
    const pair = JSON.stringify([edge.from, edge.to]);
    const pair_kinds = kinds.get(pair) ?? new Set<DependencyEdge["kind"]>();
    pair_kinds.add(edge.kind);
    kinds.set(pair, pair_kinds);
  }
  return edges.map((edge) => ({
    ...edge,
    offset_x:
      (kinds.get(JSON.stringify([edge.from, edge.to]))?.size ?? 0) > 1
        ? edge.kind === "explicit"
          ? -6
          : 6
        : 0,
  }));
}

export interface DefinitionGraphModel {
  units: DefinitionUnitOverview[];
  edges: DefinitionGraphEdge[];
  layout: GraphLayout<string>;
  breadcrumbs: DefinitionGraphBreadcrumb[];
}

export function selectDefinitionGraph({
  overview,
  dependencies,
  selection,
}: DefinitionGraphInput): DefinitionGraphModel {
  const selected =
    selection?.kind === "unit" ? overview.units.find((unit) => unit.path === selection.path) : null;
  const parent = selected?.is_group ? selected.path : (selected?.parent ?? null);
  const units = overview.units.filter((unit) => unit.parent === parent);
  const ids = new Set(units.map((unit) => unit.path));
  const edges = selectGraphEdges(dependencies.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)));
  const layout = selectGraphLayout({
    nodes: units.map((unit) => ({
      id: unit.path,
      width: DEFINITION_NODE_WIDTH,
      height: DEFINITION_NODE_HEIGHT,
    })),
    edges,
  });
  const breadcrumbs = (parent?.split("/") ?? []).map((name, index, parts) => ({
    name,
    path: parts.slice(0, index + 1).join("/"),
  }));
  return { units, edges, layout, breadcrumbs };
}


export const DEFINITION_NODE_WIDTH = 240;
export const DEFINITION_NODE_HEIGHT = 100;
export function selectDefinitionNodeLabel(text: string): string {
  return text.length > 28 ? text.slice(0, 27) + "…" : text;
}
export function selectDefinitionNodeSelected(unit: DefinitionUnitOverview, selection: DefinitionSelection | null): boolean {
  return selection?.kind === "unit" ? selection.path === unit.path : selection?.kind === "stage" && selection.stage === unit.stage;
}
