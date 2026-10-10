import { useEffect, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ArtifactId } from "../../../lib/ids";
import { formatRunWorkspaceHash } from "../../../lib/hash";
import { fetchOperatorDefinition, fetchOperatorScope, submitOperatorCommand } from "../../client";
import { useRun } from "../../hooks/useRun";
import { queryKeys } from "../../queryKeys";
import { selectLoadedScopes, selectRunScope, selectScopeDetail, selectScopeQueryIndex } from "../../lib/run-overview";
import { selectPendingCommandsForRecovery } from "../../lib/run-attention";
import { clearOperatorDraft, clearPendingCommand, listPendingCommands, operatorDraftIdentity } from "../../lib/operator-drafts";
import { isDefinitiveRequestRejection } from "../../lib/client-errors";
import type { RoutePaneTarget } from "../../lib/run-workspace";
import { RunIdentityHeader } from "../molecules/RunIdentityHeader";
import { RunWorkspaceSidebar } from "./RunWorkspaceSidebar";
import { RunOverviewPane } from "./RunOverviewPane";
import { RunDetail } from "./RunDetail";
import { RunSessionPane } from "./RunSessionPane";
import { ArtifactReview } from "./ArtifactReview";

interface Props { readonly runId: string; readonly routePane: RoutePaneTarget | null; readonly scopeId: string | null; readonly onBack: () => void }
export function RunWorkspace({ runId, routePane, scopeId, onBack }: Props) {
  const client = useQueryClient();
  const [recovery, setRecovery] = useState("");
  const attemptedScopeVersions = useRef(new Map<string, number>());
  const inFlight = useRef(new Set<string>());
  const runQuery = useRun(runId);
  const definition = useQuery({ queryKey: queryKeys.definition(runId), queryFn: () => fetchOperatorDefinition(runId) });
  const scopeQueries = useQueries({ queries: (runQuery.data?.scopes ?? []).map((scope) => ({
    queryKey: queryKeys.scope(runId, scope.scope_id), queryFn: () => fetchOperatorScope(runId, scope.scope_id),
  })) });
  const scopes = selectLoadedScopes(scopeQueries.map((query) => query.data));
  useEffect(() => {
    if (scopes.length === 0) return;
    const pending = selectPendingCommandsForRecovery({ pending: listPendingCommands(runId), scopes,
      attemptedScopeVersions: attemptedScopeVersions.current, inFlight: inFlight.current });
    if (pending.length === 0) return;
    for (const submission of pending) {
      const identity = operatorDraftIdentity(submission);
      const scope = scopes.find((item) => item.scope_id === submission.scope_id);
      if (scope) attemptedScopeVersions.current.set(identity, scope.cursor.scope_version);
      inFlight.current.add(identity);
    }
    void Promise.all(pending.map(async (submission) => {
      try {
        await submitOperatorCommand(submission);
        clearPendingCommand(submission);
        clearOperatorDraft(submission);
        return `Receipt recovered for ${submission.command_key}.`;
      } catch (cause) {
        if (isDefinitiveRequestRejection(cause)) clearPendingCommand(submission);
        return `${submission.command_key}: ${cause instanceof Error ? cause.message : "Receipt still pending"}`;
      } finally {
        inFlight.current.delete(operatorDraftIdentity(submission));
      }
    })).then((messages) => {
      setRecovery(messages.join(" "));
      void client.invalidateQueries({ queryKey: queryKeys.run(runId) });
    });
  }, [client, runId, scopes]);
  const run = runQuery.data;
  if (runQuery.isError && !runQuery.data) return <main className="or-page" role="alert">Could not load run: {String(runQuery.error)}</main>;
  if (!run) return <main className="or-page" role="status">Loading run…</main>;
  const selected = selectRunScope(run, scopeId, definition.data?.source.root ?? null);
  const detail = selectScopeDetail(scopes, selected?.scope_id ?? null);
  const selectedQuery = scopeQueries[selectScopeQueryIndex(run, selected?.scope_id ?? null)];
  const schemas = definition.data?.source.schemas ?? [];
  const navigate = (target: RoutePaneTarget | string | null) => { window.location.hash = formatRunWorkspaceHash(runId, target); };
  const refresh = () => { void client.invalidateQueries({ queryKey: queryKeys.run(runId) }); };
  return <main className="or-run-workspace" data-testid="or-run-workspace">
    <RunIdentityHeader run={run} onBack={onBack} />
    {recovery && <p role="status">{recovery}</p>}
    {runQuery.isError && <p role="alert">Refresh failed: {String(runQuery.error)}. Showing the last snapshot.</p>}
    {definition.isError && <p role="alert">Could not load pinned definition: {String(definition.error)}</p>}
    {scopeQueries.some((query) => query.isError) && <p role="alert">Some scopes could not be refreshed. Showing available projections.</p>}
    <div className="or-run-workspace__body">
      <RunWorkspaceSidebar run={run} scopes={scopes} onOpenScope={(id) => navigate(id)}
        onOpenArtifact={(id) => navigate({ kind: "artifact", artifact_id: id as ArtifactId })} />
      <div className="or-run-workspace__panes" data-testid="or-run-panes">
        {routePane?.kind === "artifact" ? <ArtifactReview revisionId={routePane.artifact_id} scopes={scopes} schemas={schemas} onBack={() => navigate(scopeId)} onRefresh={refresh} />
          : routePane?.kind === "session" ? <RunSessionPane sessionId={routePane.session_id} onOpenSession={(id) => navigate({ kind: "session", session_id: id })} />
          : <><RunOverviewPane run={run} scopes={scopes} schemas={schemas} onOpenScope={(id) => navigate(id)} />
            {detail ? <RunDetail scope={detail} schemas={schemas} onRefresh={refresh} />
              : selectedQuery?.isError ? <p role="alert">Could not load scope: {String(selectedQuery.error)}</p>
              : <p role="status">Loading scope…</p>}</>}
      </div>
    </div>
  </main>;
}
