import type { OperatorDefinitionSummary } from "../../operator-contracts";
import { Button } from "../../../components/atoms/Button";

interface Props { readonly definition: OperatorDefinitionSummary; readonly onClone: () => void }
export function WorkflowDefDetail({ definition, onClone }: Props) {
  return <section data-testid="or-def-detail"><h2>{definition.source.key} v{definition.source.version}</h2>
    <p>Digest: <code>{definition.digest}</code></p><p>Root scope: {definition.source.root}</p>
    <h3>Scopes</h3><ul>{definition.source.scopes.map((scope) => <li key={scope.key}>{scope.presentation.label}</li>)}</ul>
    <Button onClick={onClone}>Clone definition</Button>
  </section>;
}
