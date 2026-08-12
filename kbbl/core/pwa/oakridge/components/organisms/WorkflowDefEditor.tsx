import { useEffect, useMemo, useState } from "react";
import { useWorkflowDef } from "../../hooks/useWorkflowDef";
import { useCreateWorkflowDef } from "../../hooks/useCreateWorkflowDef";
import { useArtifactTypes } from "../../hooks/useArtifactTypes";
import {
  defaultRuntimeIdForConfig,
  runtimeDescriptorsForConfig,
  useServerConfig,
} from "../../../hooks/useServerConfig";
import type { EdgeDef } from "../../types";
import { StageEditor } from "../../authoring/StageEditor";
import { defaultStageEntry, type StageFormEntry } from "../../authoring/stage-form";
import { EdgeEditor } from "../../authoring/EdgeEditor";
import { buildWorkflowGraph, validateWorkflowDefinition, workflowDefinitionToFormState } from "../../lib/workflow-definition-form";
import { WorkflowJsonPreview } from "../molecules/WorkflowJsonPreview";

const secondaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--border-muted)] bg-transparent px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:border-[var(--border-hover)]";
const primaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md bg-[var(--accent-blue)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";
const inputClass =
  "w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none";
const labelClass = "block text-xs font-medium text-[var(--text-muted)] mb-1";
const addBtnClass =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--border-muted)] bg-transparent px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:border-[var(--border-hover)]";

// ── Component ─────────────────────────────────────────────────────────────────

interface WorkflowDefEditorProps {
  cloneFromId: string | null;
  onBack: () => void;
  onCreated: () => void;
}

export function WorkflowDefEditor({ cloneFromId, onBack, onCreated }: WorkflowDefEditorProps) {
  const cloneQuery = useWorkflowDef(cloneFromId);
  const artifactTypesQuery = useArtifactTypes();
  const createMutation = useCreateWorkflowDef();
  const serverConfig = useServerConfig();

  const runtimeDescriptors = useMemo(
    () => runtimeDescriptorsForConfig(serverConfig),
    [serverConfig],
  );
  const defaultRuntimeId = useMemo(
    () => defaultRuntimeIdForConfig(serverConfig),
    [serverConfig],
  );
  const defaultRuntime = runtimeDescriptors.find((r) => r.id === defaultRuntimeId) ?? runtimeDescriptors[0];
  const modelOptions = defaultRuntime?.models ?? [];
  const effortOptions = defaultRuntime?.efforts ?? [];

  const artifactTypeOptions = useMemo(
    () =>
      (artifactTypesQuery.data ?? []).map((t) => ({ value: t.id, label: t.id })),
    [artifactTypesQuery.data],
  );

  // Form state
  const [name, setName] = useState("");
  const [version, setVersion] = useState(1);
  const [stages, setStages] = useState<StageFormEntry[]>([]);
  const [edges, setEdges] = useState<EdgeDef[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Load from clone source when available
  const cloneLoaded = cloneQuery.data;
  const [populated, setPopulated] = useState(false);
  useEffect(() => {
    if (cloneLoaded && !populated) {
      setName(cloneLoaded.name);
      setVersion(cloneLoaded.version + 1);
      const { stages: s, edges: e } = workflowDefinitionToFormState(cloneLoaded);
      setStages(s);
      setEdges(e);
      setPopulated(true);
    }
  }, [cloneLoaded, populated]);

  const stageKeys = stages.map((s) => s.stageKey);

  const addStage = () => {
    const key = `stage_${stages.length + 1}`;
    setStages((prev) => [...prev, defaultStageEntry(key)]);
  };

  const updateStage = (i: number, patch: Partial<StageFormEntry>) => {
    setStages((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };

  const updateStageKey = (i: number, newKey: string) => {
    const oldKey = stages[i]?.stageKey;
    setStages((prev) => prev.map((s, idx) => (idx === i ? { ...s, stageKey: newKey } : s)));
    // Keep edges pointing at the renamed stage; a stale key makes the graph
    // non-submittable.
    if (oldKey && oldKey !== newKey) {
      setEdges((prev) =>
        prev.map((edge) => ({
          from: edge.from.stage === oldKey ? { ...edge.from, stage: newKey } : edge.from,
          to: edge.to.stage === oldKey ? { ...edge.to, stage: newKey } : edge.to,
        })),
      );
    }
  };

  const removeStage = (i: number) => {
    const stageKey = stages[i]?.stageKey;
    setStages((prev) => prev.filter((_, idx) => idx !== i));
    // Drop edges connected to the removed stage; dangling edges make the graph
    // non-submittable.
    if (stageKey) {
      setEdges((prev) =>
        prev.filter((edge) => edge.from.stage !== stageKey && edge.to.stage !== stageKey),
      );
    }
  };

  const validationResult = useMemo(
    () => validateWorkflowDefinition({ stages, edges, name }),
    [stages, edges, name],
  );
  const validationErrors = validationResult.ok ? [] : validationResult.error.details;
  const graph = useMemo(() => buildWorkflowGraph(stages, edges), [stages, edges]);
  const previewJson = useMemo(
    () => JSON.stringify({ name, version, graph }, null, 2),
    [name, version, graph],
  );

  const pending = createMutation.isPending;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validationResult.ok) return;
    setSubmitError(null);
    try {
      await createMutation.mutateAsync({ name, version, graph });
      onCreated();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to create workflow definition");
    }
  };

  const isClone = cloneFromId !== null;
  const title = isClone ? "Clone Workflow Definition" : "New Workflow Definition";

  if (isClone && cloneQuery.isPending) {
    return (
      <div className="py-6 text-sm text-[var(--text-muted)]" data-testid="or-def-editor-loading">
        Loading definition…
      </div>
    );
  }

  if (isClone && cloneQuery.isError) {
    return (
      <div
        className="rounded-md border border-[var(--danger-card-border)] bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger-fg)]"
        role="alert"
        data-testid="or-def-editor-load-error"
      >
        {cloneQuery.error instanceof Error
          ? cloneQuery.error.message
          : "Failed to load definition"}
      </div>
    );
  }

  return (
    <div className="or-page or-page--wide" data-testid="or-def-editor">
      <header className="or-page-header or-page-header--back">
        <button type="button" className={secondaryButtonClass} onClick={onBack}>
          Back
        </button>
        <div><span className="or-page-kicker">Workflow authoring</span><h2 className="or-page-title">{title}</h2><p className="or-page-summary">Define typed stages, bindings, transitions, and fan-out behavior.</p></div>
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)_360px] items-start gap-6">
        {/* Left: form */}
        <form className="flex flex-col gap-5" onSubmit={(e) => void onSubmit(e)}>
          {/* Metadata */}
          <section className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Name</span>
              <input
                type="text"
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={pending}
                placeholder="v2_dev_flow"
                required
                data-testid="or-def-name"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClass}>Version</span>
              <input
                type="number"
                className={inputClass}
                value={version}
                min={1}
                onChange={(e) =>
                  setVersion(Math.max(1, parseInt(e.target.value, 10) || 1))
                }
                disabled={pending}
                data-testid="or-def-version"
              />
            </label>
          </section>

          {/* Stages */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="m-0 text-sm font-semibold text-[var(--text-primary)]">Stages</h3>
              <button
                type="button"
                className={addBtnClass}
                onClick={addStage}
                disabled={pending}
              >
                + Add stage
              </button>
            </div>
            {stages.length === 0 && (
              <p className="text-sm text-[var(--text-muted)]">
                No stages yet. Add at least one to define the workflow.
              </p>
            )}
            {stages.map((stage, i) => (
              <StageEditor
                key={stage._uid}
                stageKey={stage.stageKey}
                entry={stage}
                onChangeKey={(k) => updateStageKey(i, k)}
                onChange={(patch) => updateStage(i, patch)}
                onRemove={() => removeStage(i)}
                artifactTypes={artifactTypeOptions}
                modelOptions={modelOptions}
                effortOptions={effortOptions}
                disabled={pending}
              />
            ))}
          </section>

          {/* Edges */}
          <section>
            <EdgeEditor
              edges={edges}
              stageKeys={stageKeys}
              onChange={setEdges}
              disabled={pending}
            />
          </section>

          {/* Validation errors */}
          {validationErrors.length > 0 && (
            <ul
              className="rounded-md border border-amber-500 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300"
              data-testid="or-def-validation-errors"
            >
              {validationErrors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          )}

          {submitError && (
            <div
              className="rounded-md border border-[var(--danger-card-border)] bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger-fg)]"
              role="alert"
              data-testid="or-def-submit-error"
            >
              {submitError}
            </div>
          )}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={onBack}
              disabled={pending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={primaryButtonClass}
              disabled={pending || validationErrors.length > 0 || stages.length === 0}
              data-testid="or-def-submit"
            >
              {pending ? "Creating…" : "Create definition"}
            </button>
          </div>
        </form>

        <WorkflowJsonPreview json={previewJson} />
      </div>
    </div>
  );
}
