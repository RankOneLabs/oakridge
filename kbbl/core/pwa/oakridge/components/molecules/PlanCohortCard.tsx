import { selectFieldItems, selectFieldText, selectBodyText } from "../../artifact-types";
import type { PlanGraphNode } from "../../lib/plan-graph";
import { OperatorTypedValue } from "./OperatorTypedValue";

interface Props { readonly node: PlanGraphNode; readonly isSelected: boolean }
export function PlanCohortCard({ node, isSelected }: Props) {
  return <li data-testid="or-plan-cohort" className="rounded-md border p-3" aria-current={isSelected}>
    <strong>{node.id}: {node.title}</strong>
    {node.depends_on.length > 0 && <p>After {node.depends_on.join(", ")}</p>}
    <p>{selectFieldText(node.cohort, "scope")}</p>
    {selectFieldItems(node.cohort, "files_in_scope").length > 0 && <section><h4>Files in scope</h4>
      <ul>{selectFieldItems(node.cohort, "files_in_scope").map((item, index) => <li key={index}>{selectBodyText(item)}</li>)}</ul>
    </section>}
    <OperatorTypedValue value={node.cohort} />
  </li>;
}
