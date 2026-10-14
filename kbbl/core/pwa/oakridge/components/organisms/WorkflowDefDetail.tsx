import type { OperatorDefinitionSummary } from "../../operator-contracts";
import { Button } from "../../../components/atoms/Button";

interface Props { readonly definition: OperatorDefinitionSummary; readonly onClone: () => void }
export function WorkflowDefDetail({ definition, onClone }: Props) {
  return <section data-testid="or-def-detail"><h2>{definition.bundle.key}</h2>
    <p>Digest: <code>{definition.digest}</code></p>
    <h3>Units</h3><ul>{definition.bundle.units.map((unit) => <li key={unit.key}>{unit.label}</li>)}</ul>
    <Button onClick={onClone}>Clone definition</Button>
  </section>;
}
