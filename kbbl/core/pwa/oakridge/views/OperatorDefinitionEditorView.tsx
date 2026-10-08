import { queryKeys } from "../queryKeys";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { decodeDefinitionBundle } from "../workflow-definition-types";
import { fetchOperatorDefinitions, pinOperatorDefinition } from "../client";
import { invalidateDefinitions } from "../lib/operator-invalidation";
import { Button } from "../../components/atoms/Button";

interface Props { readonly cloneFromId: string | null; readonly onBack: () => void; readonly onPinned: () => void }
export function OperatorDefinitionEditorView({ cloneFromId, onBack, onPinned }: Props) {
  const client = useQueryClient();
  const definitions = useQuery({ queryKey: queryKeys.definitions, queryFn: fetchOperatorDefinitions });
  const [source, setSource] = useState("");
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isReady = cloneFromId === null || loadedId === cloneFromId;
  useEffect(() => {
    if (!cloneFromId) {
      // A new definition starts empty: the catalog has no order that makes any entry the natural template.
      // Leaving a clone keeps this instance mounted, so its cloned source is cleared here.
      if (loadedId !== null) { setSource(""); setLoadedId(null); }
      return;
    }
    if (loadedId === cloneFromId) return;
    const definition = definitions.data?.find((item) => item.bundle_id === cloneFromId);
    if (definition) { setSource(JSON.stringify({ ...definition.source, version: definition.source.version + 1 }, null, 2)); setLoadedId(cloneFromId); }
  }, [cloneFromId, definitions.data, loadedId]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isReady || saving) return;
    setError(null);
    let parsed: unknown;
    try { parsed = JSON.parse(source); } catch (cause) { setError(String(cause)); return; }
    const definition = decodeDefinitionBundle(parsed);
    if (!definition) { setError("Definition does not match the source schema."); return; }
    setSaving(true);
    try { await pinOperatorDefinition(definition); invalidateDefinitions(client); onPinned(); }
    catch (cause) { setError(String(cause)); }
    finally { setSaving(false); }
  };
  return <main className="or-page or-page--wide" data-testid="or-def-editor">
    <header className="or-page-header"><Button variant="secondary" onClick={onBack}>Back</Button><h1 className="or-page-title">Definition JSON</h1></header>
    {!isReady && definitions.isPending && <p role="status">Loading definition…</p>}
    {!isReady && definitions.isError && <p role="alert">Could not load definition: {String(definitions.error)}</p>}
    {!isReady && definitions.isSuccess && !definitions.data.some((item) => item.bundle_id === cloneFromId)
      && <p role="alert">Definition not found: {cloneFromId}</p>}
    <form onSubmit={(event) => void save(event)}><label htmlFor="operator-definition-json">Source bundle</label>
      <textarea id="operator-definition-json" value={isReady ? source : ""} disabled={!isReady || saving} onChange={(event) => setSource(event.target.value)}
        className="min-h-[65vh] w-full rounded-md border p-3 font-mono text-xs" spellCheck={false} data-testid="or-def-contract" />
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={!isReady || saving} data-testid="or-def-submit">{saving ? "Pinning…" : "Pin definition"}</Button>
    </form>
  </main>;
}
