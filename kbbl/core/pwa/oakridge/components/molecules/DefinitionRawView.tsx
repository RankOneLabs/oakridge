import { Button } from "../../../components/atoms/Button";
import { useState } from "react";
import type { DefinitionSelection } from "../../../lib/hash";
import type { OperatorDefinitionDetail } from "../../operator-contracts/projections/definition-view";
import { selectDefinitionSlice } from "../../lib/definition-selection";

interface DefinitionRawViewProps { definition: OperatorDefinitionDetail; selection: DefinitionSelection | null }
export function DefinitionRawView({ definition, selection }: DefinitionRawViewProps) {
  const [tab, setTab] = useState<"Authored" | "Effective">("Authored");
  const slice = selectDefinitionSlice(tab === "Authored" ? definition.workflow : definition.effective_workflow, selection);
  return <details className="or-definition-raw"><summary>Raw JSON</summary>
    <h3>Committed definition</h3><pre>{JSON.stringify(definition.workflow, null, 2)}</pre>
    {selection && <section aria-label="Selected declaration">
      <div role="tablist" aria-label="Declaration form">{(["Authored", "Effective"] as const).map((name) => <Button key={name} role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>{name}</Button>)}</div>
      <div role="tabpanel" aria-label={tab}>{slice === null ? <p>Not present</p> : <pre>{JSON.stringify(slice, null, 2)}</pre>}</div>
    </section>}
  </details>;
}
