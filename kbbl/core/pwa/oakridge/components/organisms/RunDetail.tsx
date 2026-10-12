import type { OperatorUnitView } from "../../operator-contracts";
import { selectDraftKey } from "../../lib/operator-selectors";
import { operatorFormIdentity } from "../../lib/operator-drafts";
import { OperatorCommandForm } from "./OperatorCommandForm";
import { OperatorTypedValue } from "../molecules/OperatorTypedValue";
import { StatusBadge } from "../atoms/StatusBadge";
import { OperatorHistoryPane } from "../../views/OperatorHistoryPane";

interface Props { readonly scope: OperatorUnitView; readonly onRefresh: () => void }
export function RunDetail({ scope, onRefresh }: Props) {
  return <section data-testid="or-run-detail"><header className="flex items-center gap-2">
    <h2 data-testid="or-run-detail-title">{scope.label}</h2>
    <StatusBadge status={scope.is_terminal ? "complete" : scope.commands.length > 0 ? "attention" : "running"} testId="or-run-detail-status" />
  </header>
    <h3>State</h3><OperatorTypedValue value={scope.state} />
    {scope.outcome && <><h3>Outcome</h3><OperatorTypedValue value={scope.outcome} /></>}
    {scope.decision?.kind === "wait" && <p role="status">{scope.decision.reason}</p>}
    {scope.decision?.kind === "reject" && <p role="alert">{scope.decision.error}</p>}
    {scope.commands.length > 0 && <section><h3>Available actions</h3>{scope.commands.map((command) => {
      const draft = selectDraftKey(scope, command);
      return draft ? <OperatorCommandForm key={operatorFormIdentity(draft)} scope={scope} command={command} onRefresh={onRefresh} />
        : <p key={command.key} role="status">{command.label}: target revisions are unavailable. Refresh this scope.</p>;
    })}</section>}
    <OperatorHistoryPane runId={scope.run_id} scopeId={scope.scope_id} />
  </section>;
}
