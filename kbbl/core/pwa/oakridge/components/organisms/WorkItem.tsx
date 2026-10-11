import type { OperatorInboxItem } from "../../operator-contracts";
import { Button } from "../../../components/atoms/Button";
import { StatusBadge } from "../atoms/StatusBadge";

interface Props { readonly item: OperatorInboxItem; readonly onOpen: (runId: string, scopeId: string) => void; readonly isSettled?: boolean }
export function WorkItem({ item, onOpen, isSettled = false }: Props) {
  const title = item.kind === "diagnostic" ? item.detail : item.label;
  return <article className="or-work-item" data-testid="or-review-inbox-item" data-state={isSettled ? "settled" : "live"}>
    <div className="or-work-item__context"><StatusBadge status={isSettled ? "settled" : item.kind} /><h2>{title}</h2>
      {item.kind === "command" && <p>{item.consequence}</p>}
      {item.kind === "wait" && <p>{item.reason}</p>}
      <small>Run {item.run_id} · Scope {item.scope_id}</small>
    </div>
    <Button onClick={() => onOpen(item.run_id, item.scope_id)} disabled={isSettled}>Open work</Button>
  </article>;
}
