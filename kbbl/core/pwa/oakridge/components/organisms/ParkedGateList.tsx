import type { OperatorScopeView } from "../../operator-contracts";
import { selectActionableScopes } from "../../lib/decision-queue";
import { Button } from "../../../components/atoms/Button";

interface Props { readonly scopes: readonly OperatorScopeView[]; readonly onOpenScope: (id: string) => void }
export function ParkedGateList({ scopes, onOpenScope }: Props) {
  const actionable = selectActionableScopes(scopes);
  return <section data-testid="or-parked-gates"><h3>Decisions waiting</h3>
    {actionable.length === 0 && <p>Nothing is waiting for an operator decision.</p>}
    <ul>{actionable.map((scope) => <li key={scope.scope_id} data-testid="or-gate-card">
      <strong>{scope.label}</strong> · {scope.commands.map((command) => command.label).join(", ")}
      <Button variant="secondary" onClick={() => onOpenScope(scope.scope_id)}>Open</Button>
    </li>)}</ul>
  </section>;
}
