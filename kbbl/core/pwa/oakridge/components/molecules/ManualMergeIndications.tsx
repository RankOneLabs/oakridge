import { useQuery } from "@tanstack/react-query";
import { fetchOperatorDefinition, fetchOperatorRun } from "../../client";
import { MANUAL_MERGE_INDICATION, selectManualMergeIndication } from "../../state/manual-merge";
import type { OperatorRunView } from "../../operator-contracts/projections/run-view";
import type { OperatorDefinitionDetail } from "../../operator-contracts/projections/definition-view";
export function ManualMergeBadges({ run, definition }: { run: OperatorRunView; definition: OperatorDefinitionDetail }) {
  return <>{run.units.map((unit) => selectManualMergeIndication({ run, unit, definition }) && <p key={unit.unit_id} data-testid="manual-merge-indication" className="rounded border p-2 text-sm"><strong>{unit.label}</strong>: {MANUAL_MERGE_INDICATION}</p>)}</>;
}
/** Outside the workspace panes: indications remain visible through pane changes and terminal stages. */
export function ManualMergeIndications({ runId }: { runId: string }) {
  const run = useQuery({ queryKey: ["oakridge", "operator-run", runId], queryFn: () => fetchOperatorRun(runId), refetchInterval: 10_000 });
  const definition = useQuery({ queryKey: ["oakridge", "operator_definition", run.data?.definition_id], queryFn: () => fetchOperatorDefinition(run.data!.definition_id), enabled: run.data?.pr_integration === "github-cli" });
  return run.data && definition.data ? <ManualMergeBadges run={run.data} definition={definition.data} /> : null;
}
