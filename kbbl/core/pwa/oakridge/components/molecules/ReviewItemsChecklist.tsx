import type { OperatorReviewItemRow } from "../../operator-contracts";
import { StatusBadge } from "../atoms/StatusBadge";

interface Props { readonly items: readonly OperatorReviewItemRow[] }
export function ReviewItemsChecklist({ items }: Props) {
  return <section data-testid="or-review-items"><h4>Review items</h4>
    {items.length === 0 && <p>No review items.</p>}
    <ul>{items.map((item) => <li key={item.id} data-testid="or-review-item">
      <StatusBadge status={item.body.status} /> <strong>{item.body.title}</strong><p>{item.body.detail}</p>
    </li>)}</ul>
  </section>;
}
