import { useEffect, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ArtifactId } from "../../../lib/ids";
import { formatRunWorkspaceHash, type RoutePaneTarget } from "../../../lib/hash";
import { fetchOperatorDefinition, fetchOperatorUnit, submitOperatorDecision } from "../../client";
import { useRun } from "../../hooks/useRun";
import { queryKeys } from "../../queryKeys";
import { selectLoadedUnits, selectRunUnit, selectUnitDetail, selectUnitQueryIndex } from "../../lib/run-overview";
import { selectPendingDecisionsForRecovery } from "../../lib/run-attention";
import { clearOperatorDraft, clearPendingDecision, listPendingDecisions, operatorDraftIdentity } from "../../lib/operator-drafts";
import { isDefinitiveRequestRejection } from "../../lib/client-errors";
import { RunIdentityHeader } from "../molecules/RunIdentityHeader";
import { RunWorkspaceSidebar } from "./RunWorkspaceSidebar";
import { RunOverviewPane } from "./RunOverviewPane";
import { RunDetail } from "./RunDetail";
import { RunSessionPane } from "./RunSessionPane";
import { ArtifactReview } from "./ArtifactReview";

interface Props { readonly runId: string; readonly routePane: RoutePaneTarget | null; readonly unitId: string | null; readonly onBack: () => void }
export function RunWorkspace({ runId, routePane, unitId, onBack }: Props) {
  const client = useQueryClient();
  const [recovery, setRecovery] = useState("");
  const attempted = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  const runQuery = useRun(runId);
  const definition = useQuery({ queryKey: queryKeys.definition(runId), queryFn: () => fetchOperatorDefinition(runId) });
  const unitQueries = useQueries({ queries: (runQuery.data?.units ?? []).map((unit) => ({
    queryKey: queryKeys.unit(runId, unit.unit_id), queryFn: () => fetchOperatorUnit(runId, unit.unit_id),
  })) });
  const units = selectLoadedUnits(unitQueries.map((query) => query.data));
  useEffect(() => {
    if (units.length === 0) return;
    const pending = selectPendingDecisionsForRecovery({ pending: listPendingDecisions(runId), units,
      attempted: attempted.current, inFlight: inFlight.current });
    if (pending.length === 0) return;
    for (const submission of pending) {
      const identity = operatorDraftIdentity(submission);
      attempted.current.add(identity);
      inFlight.current.add(identity);
    }
    void Promise.all(pending.map(async (submission) => {
      try {
        await submitOperatorDecision(submission);
        clearPendingDecision(submission);
        clearOperatorDraft(submission);
        return `Receipt recovered for ${submission.decision_key}.`;
      } catch (cause) {
        if (isDefinitiveRequestRejection(cause)) clearPendingDecision(submission);
        return `${submission.decision_key}: ${cause instanceof Error ? cause.message : "Receipt still pending"}`;
      } finally {
        inFlight.current.delete(operatorDraftIdentity(submission));
      }
    })).then((messages) => {
      setRecovery(messages.join(" "));
      void client.invalidateQueries({ queryKey: queryKeys.run(runId) });
    });
  }, [client, runId, units]);
  const run = runQuery.data;
  if (runQuery.isError && !runQuery.data) return <main className="or-page" role="alert">Could not load run: {String(runQuery.error)}</main>;
  if (!run) return <main className="or-page" role="status">Loading run…</main>;
  const selected = selectRunUnit(run, unitId, definition.data?.bundle.root ?? null);
  const detail = selectUnitDetail(units, selected?.unit_id ?? null);
  const selectedQuery = unitQueries[selectUnitQueryIndex(run, selected?.unit_id ?? null)];
  const schemas = definition.data?.bundle.schemas ?? [];
  const navigate = (target: RoutePaneTarget | string | null) => { window.location.hash = formatRunWorkspaceHash(runId, target); };
  const refresh = () => { void client.invalidateQueries({ queryKey: queryKeys.run(runId) }); };
  return <main className="or-run-workspace" data-testid="or-run-workspace">
    <RunIdentityHeader run={run} onBack={onBack} />
    {recovery && <p role="status">{recovery}</p>}
    {runQuery.isError && <p role="alert">Refresh failed: {String(runQuery.error)}. Showing the last snapshot.</p>}
    {definition.isError && <p role="alert">Could not load pinned definition: {String(definition.error)}</p>}
    {unitQueries.some((query) => query.isError) && <p role="alert">Some units could not be refreshed. Showing the ones that loaded.</p>}
    <div className="or-run-workspace__body">
      <RunWorkspaceSidebar run={run} units={units} onOpenUnit={(id) => navigate(id)}
        onOpenArtifact={(id) => navigate({ kind: "artifact", artifact_id: id as ArtifactId })} />
      <div className="or-run-workspace__panes" data-testid="or-run-panes">
        {routePane?.kind === "artifact" ? <ArtifactReview revisionId={routePane.artifact_id} units={units} schemas={schemas}
          onBack={() => navigate(unitId)} onRefresh={refresh} onRevised={(id) => navigate({ kind: "artifact", artifact_id: id as ArtifactId })} />
          : routePane?.kind === "session" ? <RunSessionPane sessionId={routePane.session_id} onOpenSession={(id) => navigate({ kind: "session", session_id: id })} />
          : <><RunOverviewPane run={run} units={units} onOpenUnit={(id) => navigate(id)} />
            {detail ? <RunDetail unit={detail} schemas={schemas} onRefresh={refresh} />
              : selectedQuery?.isError ? <p role="alert">Could not load unit: {String(selectedQuery.error)}</p>
              : selected || definition.isPending ? <p role="status">Loading unit…</p>
              : definition.data ? <p role="alert">This run has no unit under its definition's root key.</p>
              : null}</>}
      </div>
    </div>
  </main>;
}
