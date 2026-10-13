import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { compileOperatorDefinition, fetchOperatorDefinitionDetail, pinOperatorDefinition } from "../client";
import { queryKeys } from "../queryKeys";
import { invalidateDefinitions } from "../lib/operator-invalidation";
import { formatWorkflowText, parseWorkflowText, selectCloneWorkflow } from "../lib/workflow-definition-form";
import { Button } from "../../components/atoms/Button";

interface Props { readonly cloneFromId: string | null; readonly onBack: () => void; readonly onPinned: () => void }

/** Author a workflow source as JSON: the authority compiles it against its prompts, and only the text that compiled is pinned. */
export function OperatorDefinitionEditorView({ cloneFromId, onBack, onPinned }: Props) {
  const client = useQueryClient();
  const detail = useQuery({ queryKey: queryKeys.definitionDetail(cloneFromId),
    queryFn: () => fetchOperatorDefinitionDetail(cloneFromId ?? ""), enabled: cloneFromId !== null });
  const [text, setText] = useState("");
  /** The text as of the latest edit, so a compile that returns after an edit does not offer to pin. */
  const currentText = useRef("");
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCompiling, setIsCompiling] = useState(false);
  const [isPinning, setIsPinning] = useState(false);
  /** The exact text that last compiled; any edit clears it. */
  const [compiled, setCompiled] = useState<string | null>(null);
  useEffect(() => {
    if (cloneFromId === null) {
      if (loadedId !== null) { currentText.current = ""; setText(""); setLoadedId(null); setCompiled(null); }
      return;
    }
    if (loadedId === cloneFromId || !detail.data) return;
    const clone = formatWorkflowText(selectCloneWorkflow(detail.data.workflow));
    currentText.current = clone; setText(clone); setLoadedId(cloneFromId); setCompiled(null);
  }, [cloneFromId, detail.data, loadedId]);
  const isReady = cloneFromId === null || loadedId === cloneFromId;
  const change = (next: string) => { currentText.current = next; setText(next); setCompiled(null); setError(null); };
  const compile = async () => {
    const snapshot = text;
    const parsed = parseWorkflowText(snapshot);
    if (!parsed.ok) { setError(parsed.error); return; }
    setError(null); setIsCompiling(true);
    try { await compileOperatorDefinition(parsed.value); if (currentText.current === snapshot) setCompiled(snapshot); }
    catch (cause) { setError(String(cause)); setCompiled(null); }
    finally { setIsCompiling(false); }
  };
  const pin = async () => {
    if (compiled === null || compiled !== text || isPinning) return;
    const parsed = parseWorkflowText(compiled);
    if (!parsed.ok) { setError(parsed.error); return; }
    setError(null); setIsPinning(true);
    try { await pinOperatorDefinition(parsed.value); invalidateDefinitions(client); onPinned(); }
    catch (cause) { setError(String(cause)); }
    finally { setIsPinning(false); }
  };
  return <main className="or-page or-page--wide" data-testid="or-def-editor">
    <header className="or-page-header"><Button variant="secondary" onClick={onBack}>Back</Button><h1 className="or-page-title">Workflow definition</h1></header>
    {!isReady && detail.isPending && <p role="status">Loading definition…</p>}
    {!isReady && detail.isError && <p role="alert">Could not load definition: {String(detail.error)}</p>}
    {isReady && <form onSubmit={(event) => { event.preventDefault(); void (compiled !== null ? pin() : compile()); }} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">Workflow JSON<textarea value={text} required onChange={(event) => change(event.target.value)}
        className="w-full min-h-96 rounded-md border p-3 font-mono text-xs" /></label>
      {error && <p role="alert">{error}</p>}
      {compiled !== null && <p role="status">Compiled successfully. Pin this definition or change it to compile again.</p>}
      <Button type="submit" disabled={isCompiling || isPinning} data-testid="or-def-submit">
        {isPinning ? "Pinning…" : isCompiling ? "Compiling…" : compiled !== null ? "Pin definition" : "Compile definition"}
      </Button>
    </form>}
  </main>;
}
