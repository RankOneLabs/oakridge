import type { OperatorRunUnitSummary } from "../../operator-contracts";
import { selectUnitStatus } from "../../lib/run-overview";
import { StatusBadge } from "../atoms/StatusBadge";
import { Button } from "../../../components/atoms/Button";

interface Props { readonly unit: OperatorRunUnitSummary; readonly onOpen: (unitId: string) => void }
export function RunStageRow({ unit, onOpen }: Props) {
  return <li className="flex items-center gap-3 border-b border-[var(--border-subtle)] py-2" data-testid="or-stage-row">
    <Button variant="secondary" onClick={() => onOpen(unit.unit_id)}>{unit.label}</Button>
    <StatusBadge status={selectUnitStatus(unit)} />
    {unit.asks.length > 0 && <span className="text-xs">{unit.asks.length} actions</span>}
  </li>;
}
