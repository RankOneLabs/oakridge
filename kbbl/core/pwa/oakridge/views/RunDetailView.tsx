import type { RoutePaneTarget } from "../lib/run-workspace";
import { RunWorkspace } from "../components/organisms/RunWorkspace";

interface Props { readonly runId: string; readonly routePane: RoutePaneTarget | null; readonly unitId: string | null; readonly onBack: () => void }
export function RunDetailView({ runId, routePane, unitId, onBack }: Props) {
  return <RunWorkspace key={runId} runId={runId} routePane={routePane} unitId={unitId} onBack={onBack} />;
}
