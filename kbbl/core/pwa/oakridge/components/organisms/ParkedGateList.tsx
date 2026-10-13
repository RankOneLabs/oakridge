import type { OperatorUnitView } from "../../operator-contracts";
import { selectActionableUnits } from "../../lib/decision-queue";
import { Button } from "../../../components/atoms/Button";

interface Props { readonly units: readonly OperatorUnitView[]; readonly onOpenUnit: (id: string) => void }
export function ParkedGateList({ units, onOpenUnit }: Props) {
  const actionable = selectActionableUnits(units);
  return <section data-testid="or-parked-gates"><h3>Decisions waiting</h3>
    {actionable.length === 0 && <p>Nothing is waiting for an operator decision.</p>}
    <ul>{actionable.map((unit) => <li key={unit.unit_id} data-testid="or-gate-card">
      <strong>{unit.label}</strong> · {unit.decisions.map((decision) => decision.label).join(", ")}
      <Button variant="secondary" onClick={() => onOpenUnit(unit.unit_id)}>Open</Button>
    </li>)}</ul>
  </section>;
}
