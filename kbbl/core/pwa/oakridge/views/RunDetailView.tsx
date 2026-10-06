import { GenericOperatorRunView } from "./GenericOperatorRunView";
import type { RoutePaneTarget } from "../lib/run-workspace";

interface RunDetailViewProps {
  readonly runId: string;
  readonly routePane: RoutePaneTarget | null;
  readonly onBack: () => void;
}

/** Commands and targets come exclusively from the pinned scope definition. */
export function RunDetailView({ runId, onBack }: RunDetailViewProps) {
  return <GenericOperatorRunView key={runId} runId={runId} onBack={onBack} />;
}
