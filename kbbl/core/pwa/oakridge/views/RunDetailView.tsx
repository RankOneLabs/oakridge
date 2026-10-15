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
  return <RunWorkspace key={runId} runId={runId} routePane={routePane} onBack={onBack} />;
}
