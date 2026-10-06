import { useEffect, useMemo, useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { useWorkflowDef } from "../../hooks/useWorkflowDef";
import { useCreateWorkflowDef } from "../../hooks/useCreateWorkflowDef";
import { validateWorkflowDefinition, workflowDefinitionToFormState } from "../../lib/workflow-definition-form";
import { WorkflowJsonPreview } from "../molecules/WorkflowJsonPreview";
import canonicalDefinition from "../../../../../../workflow-config/definitions/development.json";

interface WorkflowDefEditorProps { readonly cloneFromId: string | null; readonly onBack: () => void; readonly onCreated: () => void }

export function WorkflowDefEditor({ cloneFromId, onBack, onCreated }: WorkflowDefEditorProps) {
  const cloneQuery = useWorkflowDef(cloneFromId);
  const createMutation = useCreateWorkflowDef();
  const [source, setSource] = useState(() => JSON.stringify(canonicalDefinition, null, 2));
  const [populated, setPopulated] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  useEffect(() => {
    if (cloneQuery.data && !populated) { setSource(workflowDefinitionToFormState(cloneQuery.data)); setPopulated(true); }
  }, [cloneQuery.data, populated]);
  const validated = useMemo(() => validateWorkflowDefinition(source), [source]);
  if (cloneFromId && cloneQuery.isPending) return <div data-testid="or-def-editor-loading">Loading definition…</div>;
  if (cloneFromId && cloneQuery.isError) return <div role="alert" data-testid="or-def-editor-load-error">Failed to load definition</div>;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!validated.ok) return;
    setSubmitError(null);
    try { await createMutation.mutateAsync(validated.value); onCreated(); }
    catch (cause) { setSubmitError(cause instanceof Error ? cause.message : "Failed to create definition"); }
  };
  return <div className="or-page or-page--wide" data-testid="or-def-editor">
    <header className="or-page-header or-page-header--back">
      <Button variant="secondary" onClick={onBack}>Back</Button>
      <div><span className="or-page-kicker">Workflow authoring</span><h2 className="or-page-title">{cloneFromId ? "Clone Workflow Definition" : "New Workflow Definition"}</h2>
        <p className="or-page-summary">Configure scopes, child dependencies, workers, commands and decision trees.</p></div>
    </header>
    <form onSubmit={(event) => void submit(event)} className="grid gap-6 lg:grid-cols-2">
      <section className="flex flex-col gap-3">
        <label htmlFor="workflow-contract" className="text-sm font-semibold">Workflow contract</label>
        <textarea id="workflow-contract" value={source} onChange={(event) => setSource(event.target.value)} disabled={createMutation.isPending}
          className="min-h-[65vh] w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] p-3 font-mono text-xs"
          spellCheck={false} data-testid="or-def-contract" />
        {!validated.ok && <ul role="alert" data-testid="or-def-validation-errors">{validated.error.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>}
        {submitError && <p role="alert" data-testid="or-def-submit-error">{submitError}</p>}
        <div className="flex justify-end gap-3"><Button variant="secondary" type="button" onClick={onBack}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!validated.ok || createMutation.isPending} data-testid="or-def-submit">
            {createMutation.isPending ? "Creating…" : "Create definition"}</Button></div>
      </section>
      <WorkflowJsonPreview json={validated.ok ? JSON.stringify(validated.value, null, 2) : source} />
    </form>
  </div>;
}
