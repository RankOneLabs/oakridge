import { GenericOperatorRunView } from "./GenericOperatorRunView";
import { RunWorkspace } from "../components/organisms/RunWorkspace";
import { useState } from "react";
import { Button } from "../../components/atoms/Button";
import { useQuery } from "@tanstack/react-query";
import { fetchOperatorRun } from "../client";
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
  const probe = useQuery({ queryKey: ["operator", runId], queryFn: () => fetchOperatorRun(runId), retry: false });
  const [selectedMode, setSelectedMode] = useState<"generic" | "classic" | null>(null);
  if (probe.isPending) return <p role="status">Loading operator workspace…</p>;
  const isGeneric = selectedMode ? selectedMode === "generic" : Array.isArray(probe.data?.scopes);
  return <><Button type="button" variant="secondary" onClick={() => setSelectedMode(isGeneric ? "classic" : "generic")}>{isGeneric ? "Classic workspace" : "Definition workspace"}</Button>
    {isGeneric ? <GenericOperatorRunView key={runId} runId={runId} onBack={onBack} />
      : <RunWorkspace key={runId} runId={runId} routePane={routePane} onBack={onBack} />}</>;
}
