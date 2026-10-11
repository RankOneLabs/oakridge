import type { OperatorRunView, OperatorScopeView, OperatorSchema } from "../../operator-contracts";
import { selectCompletedScopeDetails, selectFinalIntegrationScope, selectRunProgress, selectWaitingScopes } from "../../lib/run-overview";
import { OperatorTypedValue } from "../molecules/OperatorTypedValue";
import { RunStageRow } from "../molecules/RunStageRows";
import { ParkedGateList } from "./ParkedGateList";
import { FinalIntegrationPanel } from "./FinalIntegrationPanel";

interface Props { readonly run: OperatorRunView; readonly scopes: readonly OperatorScopeView[]; readonly schemas: readonly OperatorSchema[]; readonly onOpenScope: (id: string) => void }
export function RunOverviewPane({ run, scopes, schemas, onOpenScope }: Props) {
  const progress = selectRunProgress(run);
  const finalIntegration = selectFinalIntegrationScope(scopes);
  return <section data-testid="or-run-overview"><h2>Overview</h2>
    <p>{progress.complete} of {progress.total} scopes complete · {progress.needs_attention} need attention</p>
    <ul>{run.scopes.map((scope) => <RunStageRow key={scope.scope_id} scope={scope} onOpen={onOpenScope} />)}</ul>
    <ParkedGateList scopes={scopes} onOpenScope={onOpenScope} />
    {finalIntegration && <FinalIntegrationPanel scope={finalIntegration} schemas={schemas} />}
    {selectWaitingScopes(scopes).map((scope) => <section key={scope.scope_id}>
      <h3>{scope.label}</h3><p>{scope.decision?.kind === "wait" ? scope.decision.reason : ""}</p>
    </section>)}
    {selectCompletedScopeDetails(scopes).map((scope) => <section key={scope.scope_id}>
      <h3>{scope.label} outcome</h3>{scope.outcome && <OperatorTypedValue value={scope.outcome} schemas={schemas} />}
    </section>)}
  </section>;
}
