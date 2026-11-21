import { useQuery } from "@tanstack/react-query";
import { fetchOperatorRun } from "../../client";
import { selectOperatorActionRows } from "../../lib/operator-actions";
import { OperatorActionsList } from "../molecules/OperatorActionsList";

interface OperatorActionsHistoryProps {
  readonly runId: string;
}

export function OperatorActionsHistory({ runId }: OperatorActionsHistoryProps) {
  const run = useQuery({ queryKey: ["oakridge", "operator-run", runId], queryFn: () => fetchOperatorRun(runId), refetchInterval: 10_000 });
  const rows = selectOperatorActionRows(run.data ?? {});
  return rows.length > 0 ? <OperatorActionsList rows={rows} /> : null;
}
