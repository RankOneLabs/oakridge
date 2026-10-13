import type { OperatorBodyValue } from "../../operator-contracts";
import { selectFieldText } from "../../artifact-types";

interface Props { readonly risk: OperatorBodyValue }
export function RiskCard({ risk }: Props) {
  return <div className="rounded-md border border-[var(--amber-border)] bg-[var(--amber-bg)] px-3 py-2" data-testid="or-risk-card">
    <p>{selectFieldText(risk, "description") ?? "Risk"}</p>
    <small>Mitigation: {selectFieldText(risk, "mitigation") ?? "None given"}</small>
  </div>;
}
