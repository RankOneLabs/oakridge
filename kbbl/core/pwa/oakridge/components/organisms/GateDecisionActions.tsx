import type { OperatorUnitView } from "../../operator-contracts";
import { selectArtifactCommands } from "../../lib/decision-queue";
import { selectDraftKey } from "../../lib/operator-selectors";
import { operatorFormIdentity } from "../../lib/operator-drafts";
import { OperatorCommandForm } from "./OperatorCommandForm";

interface Props { readonly scope: OperatorUnitView; readonly revisionId: string; readonly onRefresh: () => void }
export function GateDecisionActions({ scope, revisionId, schemas, onRefresh }: Props) {
  const commands = selectArtifactCommands(scope, revisionId);
  if (commands.length === 0) return null;
  return <section data-testid="or-gate-actions"><h3>Decisions</h3>{commands.map((command) => {
    const draft = selectDraftKey(scope, command);
    return draft ? <OperatorCommandForm key={operatorFormIdentity(draft)} scope={scope} command={command} onRefresh={onRefresh} />
      : <p key={command.key} role="status">{command.label}: target revisions are unavailable.</p>;
  })}</section>;
}
