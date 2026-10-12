import { selectBodyField, selectItems, selectText, selectFieldItems, selectFieldText } from "../artifact-types";

export interface PlanGraphNode { readonly id: string; readonly title: string; readonly depends_on: readonly string[]; readonly cohort: unknown }
export interface PlanGraphLayoutNode extends PlanGraphNode { readonly x: number; readonly y: number }
export interface PlanGraphLayout { readonly nodes: readonly PlanGraphLayoutNode[]; readonly edges: readonly { readonly from: string; readonly to: string; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }[]; readonly width: number; readonly height: number }

export function selectPlanGraph(body: unknown): PlanGraphLayout {
  const dependencyOrder = selectFieldItems(body, "dependency_order").flatMap((item) => {
    const id = selectText(item); return id === null ? [] : [id];
  });
  const order = new Map(dependencyOrder.map((id, index) => [id, index]));
  const cohorts = selectFieldItems(body, "cohorts").map((cohort) => ({
    id: selectFieldText(cohort, "id") ?? "",
    title: selectFieldText(cohort, "title") ?? "Untitled cohort",
    depends_on: selectItems(selectBodyField(cohort, "depends_on")).flatMap((item) => {
      const id = selectText(item); return id === null ? [] : [id];
    }),
    cohort,
  })).filter((cohort) => cohort.id.length > 0)
    .sort((left, right) => (order.get(left.id) ?? dependencyOrder.length) - (order.get(right.id) ?? dependencyOrder.length));
  const nodes = cohorts.map((cohort, index) => ({ ...cohort, x: 24 + index * 230, y: 36 }));
  const edges = nodes.flatMap((to) => to.depends_on.flatMap((from) => {
    const source = nodes.find((node) => node.id === from);
    return source ? [{ from, to: to.id, x1: source.x + 180, y1: source.y + 35, x2: to.x, y2: to.y + 35 }] : [];
  }));
  return { nodes, edges, width: Math.max(320, cohorts.length * 230 + 24), height: 150 };
}
