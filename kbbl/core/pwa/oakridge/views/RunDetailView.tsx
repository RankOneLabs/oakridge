import { ManualMergeIndications } from "../components/organisms/ManualMergeIndications";
import { OperatorActionsHistory } from "../components/organisms/OperatorActionsHistory";
import { RunWorkspace } from "../components/organisms/RunWorkspace";
import type { RoutePaneTarget } from "../lib/run-workspace";

interface RunDetailViewProps {
  runId: string;
  routePane: RoutePaneTarget | null;
  onBack: () => void;
}

/**
 * `#oakridge/run/:id` — the run command center.
 *
 * The workspace is keyed by run id so moving between runs starts a fresh
 * restore: each run's arrangement comes back from its own stored entry rather
 * than the previous run's leaking across the navigation.
 */
export function RunDetailView({ runId, routePane, onBack }: RunDetailViewProps) {
  return <div className="or-run-detail flex h-full min-h-0 flex-col overflow-hidden">
    <div className="max-h-1/3 shrink-0 overflow-y-auto">
      <ManualMergeIndications runId={runId} />
      <OperatorActionsHistory runId={runId} />
    </div>
    <div className="min-h-0 flex-1">
      <RunWorkspace key={runId} runId={runId} routePane={routePane} onBack={onBack} />
    </div>
  </div>;
}
