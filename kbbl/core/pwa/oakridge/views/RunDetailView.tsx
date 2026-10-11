import type { RoutePaneTarget } from "../lib/run-workspace";
import { RunWorkspace } from "../components/organisms/RunWorkspace";

interface Props { readonly runId: string; readonly routePane: RoutePaneTarget | null; readonly scopeId: string | null; readonly onBack: () => void }
export function RunDetailView({ runId, routePane, scopeId, onBack }: Props) {
  return <RunWorkspace key={runId} runId={runId} routePane={routePane} scopeId={scopeId} onBack={onBack} />;
}
