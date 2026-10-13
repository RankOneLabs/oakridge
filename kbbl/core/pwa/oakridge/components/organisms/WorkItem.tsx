import type { OperatorInboxItem } from "../../operator-contracts";
import { Button } from "../../../components/atoms/Button";
import { StatusBadge } from "../atoms/StatusBadge";

interface Props { readonly item: OperatorInboxItem; readonly onOpen: (runId: string, unitId: string) => void; readonly isSettled?: boolean }
export function WorkItem({ item, onOpen, isSettled = false }: Props) {
  const title = item.kind === "stalled" ? item.detail : item.label;
  return <article className={`or-work-item${isSettled ? " or-work-item--settled" : ""}`}
    data-testid="or-review-inbox-item" data-state={isSettled ? "settled" : "live"}>
    <div className="or-work-item__context"><StatusBadge status={isSettled ? "settled" : item.kind} /><h2>{title}</h2>
      {item.kind === "waiting" && <p>{item.reason}</p>}
      <small>Run {item.run_id} · Unit {item.unit_id}</small>
    </div>
    <Button onClick={() => onOpen(item.run_id, item.unit_id)} disabled={isSettled}>Open work</Button>
  </article>;
}
