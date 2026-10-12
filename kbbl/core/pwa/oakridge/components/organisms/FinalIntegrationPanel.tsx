import type { OperatorUnitView } from "../../operator-contracts";
import { OperatorTypedValue } from "../molecules/OperatorTypedValue";
import { StatusBadge } from "../atoms/StatusBadge";

interface Props { readonly scope: OperatorUnitView; }
export function FinalIntegrationPanel({ scope }: Props) {
  return <section data-testid="or-final-integration"><h3>Final integration</h3>
    <StatusBadge status={scope.is_terminal ? "complete" : scope.commands.length > 0 ? "attention" : "running"} />
    {scope.outcome && <OperatorTypedValue value={scope.outcome} />}
    {scope.outputs.map((output) => output.current_revision && <div key={output.id}>
      <h4>{output.output_key}</h4><OperatorTypedValue value={output.current_revision.body} />
    </div>)}
  </section>;
}
