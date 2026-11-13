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
export interface DefinitionGraphModel {
  units: DefinitionUnitOverview[];
  edges: DependencyEdge[];
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
  const edges = dependencies.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  const layout = selectGraphLayout({
    nodes: units.map((unit) => ({
      id: unit.path,
      width: Math.max(
        330,
        ...[unit.for_each, unit.key_expression, unit.after, unit.pool].map(
          (text) => (text?.length ?? 0) * 7 + 100,
        ),
      ),
      height: 150,
    })),
    edges,
  });
  const breadcrumbs = (parent?.split("/") ?? []).map((name, index, parts) => ({
    name,
    path: parts.slice(0, index + 1).join("/"),
  }));
  return { units, edges, layout, breadcrumbs };
}
