import type { OperatorCheckedValue, OperatorSchema } from "../operator-contracts";
import { selectCheckedField, selectCheckedItems, selectCheckedText, selectFieldItems, selectFieldText } from "../artifact-types";

export interface PlanGraphNode { readonly id: string; readonly title: string; readonly depends_on: readonly string[]; readonly cohort: OperatorCheckedValue }
export interface PlanGraphLayoutNode extends PlanGraphNode { readonly x: number; readonly y: number }
export interface PlanGraphLayout { readonly nodes: readonly PlanGraphLayoutNode[]; readonly edges: readonly { readonly from: string; readonly to: string; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }[]; readonly width: number; readonly height: number }

export function selectPlanGraph(body: OperatorCheckedValue, schemas: readonly OperatorSchema[]): PlanGraphLayout {
  const cohorts = selectFieldItems(body, schemas, "cohorts").map((cohort) => ({
    id: selectFieldText(cohort, schemas, "id") ?? "",
    title: selectFieldText(cohort, schemas, "title") ?? "Untitled cohort",
    depends_on: selectCheckedItems(selectCheckedField(cohort, schemas, "depends_on")).flatMap((item) => {
      const id = selectCheckedText(item); return id === null ? [] : [id];
    }),
    cohort,
  })).filter((cohort) => cohort.id.length > 0);
  const nodes = cohorts.map((cohort, index) => ({ ...cohort, x: 24 + index * 230, y: 36 }));
  const edges = nodes.flatMap((to) => to.depends_on.flatMap((from) => {
    const source = nodes.find((node) => node.id === from);
    return source ? [{ from, to: to.id, x1: source.x + 180, y1: source.y + 35, x2: to.x, y2: to.y + 35 }] : [];
  }));
  return { nodes, edges, width: Math.max(320, cohorts.length * 230 + 24), height: 150 };
}
