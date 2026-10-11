import type { OperatorSchema } from "../../operator-contracts";
import { selectFieldItems, selectFieldText, selectCheckedText } from "../../artifact-types";
import type { PlanGraphNode } from "../../lib/plan-graph";
import { OperatorTypedValue } from "./OperatorTypedValue";

interface Props { readonly node: PlanGraphNode; readonly schemas: readonly OperatorSchema[]; readonly isSelected: boolean }
export function PlanCohortCard({ node, schemas, isSelected }: Props) {
  return <li data-testid="or-plan-cohort" className="rounded-md border p-3" aria-current={isSelected}>
    <strong>{node.id}: {node.title}</strong>
    {node.depends_on.length > 0 && <p>After {node.depends_on.join(", ")}</p>}
    <p>{selectFieldText(node.cohort, schemas, "scope")}</p>
    {selectFieldItems(node.cohort, schemas, "files_in_scope").length > 0 && <section><h4>Files in scope</h4>
      <ul>{selectFieldItems(node.cohort, schemas, "files_in_scope").map((item, index) => <li key={index}>{selectCheckedText(item)}</li>)}</ul>
    </section>}
    <OperatorTypedValue value={node.cohort} schemas={schemas} />
  </li>;
}
