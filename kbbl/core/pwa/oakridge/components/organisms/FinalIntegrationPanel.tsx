import type { OperatorUnitView } from "../../operator-contracts";
import { OperatorTypedValue } from "../molecules/OperatorTypedValue";
import { StatusBadge } from "../atoms/StatusBadge";
import { selectUnitBadgeStatus } from "../../lib/run-overview";

interface Props { readonly unit: OperatorUnitView }
export function FinalIntegrationPanel({ unit }: Props) {
  return <section data-testid="or-final-integration"><h3>Final integration</h3>
    <StatusBadge status={selectUnitBadgeStatus(unit.status, unit.decisions.length > 0)} />
    {unit.outcome && <OperatorTypedValue value={unit.outcome} />}
    {unit.artifacts.map((artifact) => artifact.latest_revision && <div key={artifact.artifact_key}>
      <h4>{artifact.artifact_key}</h4><OperatorTypedValue value={artifact.latest_revision.body} />
    </div>)}
  </section>;
}
