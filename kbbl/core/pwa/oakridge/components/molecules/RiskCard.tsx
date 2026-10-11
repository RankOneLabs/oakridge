import type { OperatorCheckedValue, OperatorSchema } from "../../operator-contracts";
import { selectFieldText } from "../../artifact-types";

interface Props { readonly risk: OperatorCheckedValue; readonly schemas: readonly OperatorSchema[] }
export function RiskCard({ risk, schemas }: Props) {
  return <div className="rounded-md border border-[var(--amber-border)] bg-[var(--amber-bg)] px-3 py-2" data-testid="or-risk-card">
    <p>{selectFieldText(risk, schemas, "description") ?? "Risk"}</p>
    <small>Mitigation: {selectFieldText(risk, schemas, "mitigation") ?? "None given"}</small>
  </div>;
}
