import type { OperatorRunScopeSummary } from "../../operator-contracts";
import { selectScopeStatus } from "../../lib/run-overview";
import { StatusBadge } from "../atoms/StatusBadge";
import { Button } from "../../../components/atoms/Button";

interface Props { readonly scope: OperatorRunScopeSummary; readonly onOpen: (scopeId: string) => void }
export function RunStageRow({ scope, onOpen }: Props) {
  return <li className="flex items-center gap-3 border-b border-[var(--border-subtle)] py-2" data-testid="or-stage-row">
    <Button variant="secondary" onClick={() => onOpen(scope.scope_id)}>{scope.label}</Button>
    <StatusBadge status={selectScopeStatus(scope)} />
    {scope.available_commands.length > 0 && <span className="text-xs">{scope.available_commands.length} actions</span>}
  </li>;
}
