import type { OperatorSchema, OperatorUnitView } from "../../operator-contracts";
import { selectArtifactDecisions } from "../../lib/decision-queue";
import { selectDraftKey } from "../../lib/operator-selectors";
import { operatorDraftIdentity } from "../../lib/operator-drafts";
import { OperatorDecisionForm } from "./OperatorDecisionForm";

interface Props { readonly unit: OperatorUnitView; readonly revisionId: string; readonly schemas: readonly OperatorSchema[]; readonly onRefresh: () => void }
export function GateDecisionActions({ unit, revisionId, schemas, onRefresh }: Props) {
  const decisions = selectArtifactDecisions(unit, revisionId);
  if (decisions.length === 0) return null;
  return <section data-testid="or-gate-actions"><h3>Decisions</h3>{decisions.map((decision) =>
    <OperatorDecisionForm key={operatorDraftIdentity(selectDraftKey(unit, decision))} unit={unit} decision={decision} schemas={schemas} onRefresh={onRefresh} />)}</section>;
}
