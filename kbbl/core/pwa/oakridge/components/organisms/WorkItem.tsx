import type { OperatorInboxItem } from "../../operator-contracts";
import { Button } from "../../../components/atoms/Button";
import { StatusBadge } from "../atoms/StatusBadge";

interface Props { readonly item: OperatorInboxItem; readonly onOpen: (runId: string, scopeId: string) => void }
export function WorkItem({ item, onOpen }: Props) {
  const title = item.kind === "diagnostic" ? item.detail : item.label;
  return <article className="or-work-item" data-testid="or-review-inbox-item">
    <div className="or-work-item__context"><StatusBadge status={item.kind} /><h2>{title}</h2>
      {item.kind === "command" && <p>{item.consequence}</p>}
      {item.kind === "wait" && <p>{item.reason}</p>}
      <small>Run {item.run_id} · Scope {item.scope_id}</small>
    </div>
    <Button onClick={() => onOpen(item.run_id, item.scope_id)}>Open work</Button>
  </article>;
}
