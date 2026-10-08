import { queryKeys } from "../queryKeys";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchOperatorDefinition, fetchOperatorRun, fetchOperatorScope, submitOperatorCommand } from "../client";
import { OperatorCommandForm } from "../components/organisms/OperatorCommandForm";
import { OperatorTypedValue } from "../components/molecules/OperatorTypedValue";
import { clearOperatorDraft, clearPendingCommand, listPendingCommands, operatorDraftIdentity } from "../lib/operator-drafts";
import { selectDraftKey, selectRootScopeId } from "../lib/operator-selectors";
import { Button } from "../../components/atoms/Button";
import { isDefinitiveRequestRejection } from "../lib/client-errors";
import { OperatorHistoryPane } from "./OperatorHistoryPane";

interface Props { readonly runId: string; readonly onBack: () => void }
export function GenericOperatorRunView({ runId, onBack }: Props) {
  const client = useQueryClient();
  const run = useQuery({ queryKey: queryKeys.run(runId), queryFn: () => fetchOperatorRun(runId) });
  const definition = useQuery({ queryKey: queryKeys.definition(runId), queryFn: () => fetchOperatorDefinition(runId) });
  const [selectedScope, setSelectedScope] = useState<string | null>(null);
  const rootScopeId = run.data && definition.data
    ? selectRootScopeId({ scopes: run.data.scopes, root_key: definition.data.source.root }) : null;
  const scopeId = selectedScope ?? rootScopeId;
  const scope = useQuery({ queryKey: queryKeys.scope(runId, scopeId), queryFn: () => fetchOperatorScope(runId, scopeId ?? ""), enabled: scopeId !== null });
  const [selectedCommand, setSelectedCommand] = useState<string | null>(null);
  const selected = scope.data?.commands.find((command) => command.key === selectedCommand) ?? scope.data?.commands[0];
  const schemas = definition.data?.source.schemas ?? [];
  const refresh = () => { void client.invalidateQueries({ queryKey: queryKeys.run(runId) }); };
  const [recovery, setRecovery] = useState("");
  useEffect(() => {
    if (!scope.data) return;
    const currentIdentity = selected ? selectDraftKey(scope.data, selected) : null;
    const pending = listPendingCommands(runId).filter((item) =>
      !currentIdentity || operatorDraftIdentity(item) !== operatorDraftIdentity(currentIdentity));
    if (pending.length === 0) return;
    let cancelled = false;
    void Promise.all(pending.map(async (item) => {
      try { await submitOperatorCommand(item); clearPendingCommand(item); clearOperatorDraft(item); return `Receipt recovered for ${item.command_key}.`; }
      catch (cause) {
        if (isDefinitiveRequestRejection(cause)) clearPendingCommand(item);
        return `${item.command_key}: ${cause instanceof Error ? cause.message : "Receipt still pending"}`;
      }
    })).then((messages) => { if (!cancelled) { setRecovery(messages.join(" ")); refresh(); } });
    return () => { cancelled = true; };
    // Recovery is tied to the observed scope version; pending requests keep their original payload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, scope.data?.cursor.scope_version]);
  const refreshError = run.error ?? definition.error ?? scope.error;
  if (run.data && definition.data && scopeId === null) return <div role="alert">This run has no scope matching the definition's root.</div>;
  if (!run.data || !definition.data || !scope.data) return refreshError
    ? <div role="alert">{String(refreshError)}</div> : <p role="status">Loading operator context…</p>;
  return <main className="or-page or-page--wide" data-testid="operator-run-view">
    {refreshError && <p role="alert">Refresh failed: {String(refreshError)}. Showing the last snapshot.</p>}
    {recovery && <p role="status">{recovery}</p>}
    <header className="or-page-header"><Button type="button" variant="secondary" onClick={onBack}>← Runs</Button><h2 className="or-page-title">Operator workspace</h2><Button type="button" variant="secondary" onClick={refresh}>Refresh</Button></header>
    <label>Scope <select aria-label="Scope" value={scopeId ?? ""} onChange={(event) => { setSelectedScope(event.target.value); setSelectedCommand(null); }}>
      {run.data.scopes.map((item) => <option key={item.scope_id} value={item.scope_id}>{item.label}</option>)}
    </select></label>
    <section><h3>{scope.data.label}</h3><OperatorTypedValue value={scope.data.state} schemas={schemas} />
      {scope.data.outcome && <><h4>Outcome</h4><OperatorTypedValue value={scope.data.outcome} schemas={schemas} /></>}
      {scope.data.outputs.map((output) => <section key={output.id}>
        <h4>{output.output_key}{output.collection_key && ` · ${output.collection_key}`}</h4>
        {output.current_revision ? <OperatorTypedValue value={output.current_revision.body} schemas={schemas} />
          : <p>No artifact published.</p>}
      </section>)}
      {scope.data.executions.map((execution) => <section key={execution.id}><h4>{execution.worker_key} · {execution.status}</h4>
        {execution.result && <OperatorTypedValue value={execution.result} schemas={schemas} />}</section>)}
    </section>
    <OperatorHistoryPane runId={runId} scopeId={scopeId ?? ""} schemas={schemas} />
    {scope.data.commands.length > 0 && <section><h3>Commands</h3>
      <label>Action <select aria-label="Action" value={selected?.key ?? ""} onChange={(event) => setSelectedCommand(event.target.value)}>
        {scope.data.commands.map((command) => <option key={command.key} value={command.key}>{command.label}</option>)}
      </select></label>
      {selected && selectDraftKey(scope.data, selected) && <OperatorCommandForm key={operatorDraftIdentity(selectDraftKey(scope.data, selected)!)}
        scope={scope.data} command={selected} schemas={schemas} onRefresh={refresh} />}
      {selected && !selectDraftKey(scope.data, selected) && <p role="status">Target revisions are unavailable. Refresh this scope before acting.</p>}
    </section>}
  </main>;
}
