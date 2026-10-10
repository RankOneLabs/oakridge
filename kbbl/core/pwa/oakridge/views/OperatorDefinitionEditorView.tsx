import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkflowAuthoring } from "../../../../../workflow-config/src/authoring";
import { compileOperatorDefinition, fetchOperatorDefinitionDetail, pinOperatorDefinition } from "../client";
import { queryKeys } from "../queryKeys";
import { invalidateDefinitions } from "../lib/operator-invalidation";
import { EMPTY_AUTHORING, selectCloneAuthoring, selectStoredAuthoring } from "../lib/workflow-definition-form";
import { Button } from "../../components/atoms/Button";

interface Props { readonly cloneFromId: string | null; readonly onBack: () => void; readonly onPinned: () => void }

export function OperatorDefinitionEditorView({ cloneFromId, onBack, onPinned }: Props) {
  const client = useQueryClient();
  const detail = useQuery({ queryKey: queryKeys.definitionDetail(cloneFromId),
    queryFn: () => fetchOperatorDefinitionDetail(cloneFromId ?? ""), enabled: cloneFromId !== null });
  const [authoring, setAuthoring] = useState<WorkflowAuthoring>(EMPTY_AUTHORING);
  const currentAuthoring = useRef<WorkflowAuthoring>(EMPTY_AUTHORING);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCompiling, setIsCompiling] = useState(false);
  const [isPinning, setIsPinning] = useState(false);
  const [compiled, setCompiled] = useState<WorkflowAuthoring | null>(null);
  useEffect(() => {
    if (cloneFromId === null) {
      if (loadedId !== null) { currentAuthoring.current = EMPTY_AUTHORING; setAuthoring(EMPTY_AUTHORING); setLoadedId(null); setCompiled(null); }
      return;
    }
    if (loadedId === cloneFromId || !detail.data) return;
    const stored = selectStoredAuthoring(detail.data);
    if (stored) { const clone = selectCloneAuthoring(stored); currentAuthoring.current = clone; setAuthoring(clone); setLoadedId(cloneFromId); setCompiled(null); }
  }, [cloneFromId, detail.data, loadedId]);
  const isReady = cloneFromId === null || loadedId === cloneFromId;
  const change = <Key extends keyof WorkflowAuthoring>(key: Key, value: WorkflowAuthoring[Key]) => {
    setAuthoring((current) => { const next = { ...current, [key]: value }; currentAuthoring.current = next; return next; });
    setCompiled(null); setError(null);
  };
  const compile = async () => {
    const snapshot = currentAuthoring.current;
    setError(null); setIsCompiling(true);
    try { await compileOperatorDefinition(snapshot); if (currentAuthoring.current === snapshot) setCompiled(snapshot); }
    catch (cause) { setError(String(cause)); setCompiled(null); }
    finally { setIsCompiling(false); }
  };
  const pin = async () => {
    if (compiled === null || compiled !== currentAuthoring.current || isPinning) return;
    setError(null); setIsPinning(true);
    try { await pinOperatorDefinition(compiled); invalidateDefinitions(client); onPinned(); }
    catch (cause) { setError(String(cause)); }
    finally { setIsPinning(false); }
  };
  return <main className="or-page or-page--wide" data-testid="or-def-editor">
    <header className="or-page-header"><Button variant="secondary" onClick={onBack}>Back</Button><h1 className="or-page-title">Workflow definition</h1></header>
    {!isReady && detail.isPending && <p role="status">Loading definition…</p>}
    {!isReady && detail.isError && <p role="alert">Could not load definition: {String(detail.error)}</p>}
    {!isReady && detail.data !== undefined && !selectStoredAuthoring(detail.data) && <p role="alert">This definition has no editable authoring model.</p>}
    {isReady && <form onSubmit={(event) => { event.preventDefault(); void (compiled !== null ? pin() : compile()); }} className="flex flex-col gap-3">
      <label>Key<input value={authoring.key} pattern="[a-z][a-z0-9-]*" required onChange={(event) => change("key", event.target.value)} /></label>
      <label>Implementation capacity<input type="number" min={1} max={4294967295} value={authoring.implementation_capacity}
        onChange={(event) => change("implementation_capacity", Number(event.target.value))} /></label>
      <label>Sibling failure<select value={authoring.sibling_failure} onChange={(event) => change("sibling_failure", event.target.value as WorkflowAuthoring["sibling_failure"])}>
        <option value="cancel">Cancel siblings</option><option value="continue_independent">Continue independent siblings</option>
      </select></label>
      <label>Wire field order<select value={authoring.wire_field_order} onChange={(event) => change("wire_field_order", event.target.value as WorkflowAuthoring["wire_field_order"])}>
        <option value="canonical">Canonical</option><option value="alternate">Alternate</option>
      </select></label>
      <label>Stage layout<select value={authoring.stage_layout} onChange={(event) => change("stage_layout", event.target.value as WorkflowAuthoring["stage_layout"])}>
        <option value="standard">Standard</option><option value="verification">Verification</option>
      </select></label>
      {error && <p role="alert">{error}</p>}
      {compiled !== null && <p role="status">Compiled successfully. Pin this definition or change a field to compile again.</p>}
      <Button type="submit" disabled={isCompiling || isPinning} data-testid="or-def-submit">
        {isPinning ? "Pinning…" : isCompiling ? "Compiling…" : compiled !== null ? "Pin definition" : "Compile definition"}
      </Button>
    </form>}
  </main>;
}
