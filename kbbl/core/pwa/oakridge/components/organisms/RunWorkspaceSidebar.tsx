import type { OperatorRunView, OperatorScopeView } from "../../operator-contracts";
import { selectRunArtifacts } from "../../lib/run-overview";
import { selectRunExecutions } from "../../lib/run-sessions";
import { RunSidebarArtifacts } from "../molecules/RunSidebarArtifacts";
import { RunSidebarSessions } from "../molecules/RunSidebarSessions";
import { RunStageRow } from "../molecules/RunStageRows";

interface Props {
  readonly run: OperatorRunView; readonly scopes: readonly OperatorScopeView[];
  readonly onOpenScope: (id: string) => void; readonly onOpenArtifact: (id: string) => void;
}
export function RunWorkspaceSidebar({ run, scopes, onOpenScope, onOpenArtifact }: Props) {
  return <aside className="or-run-workspace__sidebar" data-testid="or-run-sidebar">
    <section><h2>Scopes</h2><ul>{run.scopes.map((scope) => <RunStageRow key={scope.scope_id} scope={scope} onOpen={onOpenScope} />)}</ul></section>
    <RunSidebarSessions executions={selectRunExecutions(scopes)} onOpen={onOpenScope} />
    <RunSidebarArtifacts artifacts={selectRunArtifacts(scopes)} onOpen={onOpenArtifact} />
  </aside>;
}
