import { useQuery } from "@tanstack/react-query";
import { fetchPinnedRunDefinition, fetchOperatorRun } from "../../client";
import { ManualMergeBadges } from "../molecules/ManualMergeIndications";
interface ManualMergeIndicationsProps { readonly runId: string }
/** Outside the workspace panes: notices survive pane changes and catalog updates. */
export function ManualMergeIndications({ runId }: ManualMergeIndicationsProps) {
  const run = useQuery({ queryKey: ["oakridge", "operator-run", runId], queryFn: () => fetchOperatorRun(runId), refetchInterval: 10_000 });
  const definition = useQuery({ queryKey: ["oakridge", "pinned-run-definition", runId], queryFn: () => fetchPinnedRunDefinition(runId), enabled: run.data?.pr_integration === "github-cli" });
  return run.data && definition.data ? <ManualMergeBadges run={run.data} definition={definition.data} /> : null;
}
