import { useEffect, useMemo, useState } from "react";
import { useWorkflowDef, useCreateWorkflowDef, useArtifactTypes } from "./hooks";
import {
  defaultRuntimeIdForConfig,
  runtimeDescriptorsForConfig,
  useServerConfig,
} from "../hooks/useServerConfig";
import type { WorkflowGraph, EdgeDef, WorkflowDefFull } from "./types";
import { StageEditor, defaultStageEntry, stageFormEntryToNodeDef } from "./authoring/StageEditor";
import type { StageFormEntry } from "./authoring/StageEditor";
import { EdgeEditor } from "./authoring/EdgeEditor";

const secondaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--border-muted)] bg-transparent px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:border-[var(--border-hover)]";
const primaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md bg-[var(--accent-blue)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";
const inputClass =
  "w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none";
const labelClass = "block text-xs font-medium text-[var(--text-muted)] mb-1";
const addBtnClass =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--border-muted)] bg-transparent px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:border-[var(--border-hover)]";

// ── Validation ────────────────────────────────────────────────────────────────

function validateGraph(
  stages: StageFormEntry[],
  edges: EdgeDef[],
  name: string,
): string[] {
  const errors: string[] = [];
  if (!name.trim()) errors.push("Name is required.");

  const stageKeys = new Set<string>();
  for (const s of stages) {
    if (!s.stageKey.trim()) {
      errors.push("Each stage must have a non-empty key.");
    } else if (stageKeys.has(s.stageKey)) {
      errors.push(`Duplicate stage key: "${s.stageKey}".`);
    } else {
      stageKeys.add(s.stageKey);
    }
  }

  for (const e of edges) {
    if (!e.from.stage || !e.to.stage) {
      errors.push("Each edge must have a from/to stage.");
    } else {
      if (!stageKeys.has(e.from.stage)) {
        errors.push(`Edge references unknown from-stage: "${e.from.stage}".`);
      }
      if (!stageKeys.has(e.to.stage)) {
        errors.push(`Edge references unknown to-stage: "${e.to.stage}".`);
      }
      if (!e.from.slot) {
        errors.push(`Edge from "${e.from.stage}" — from-slot must not be empty.`);
      }
      if (!e.to.slot) {
        errors.push(`Edge to "${e.to.stage}" — to-slot must not be empty.`);
      }
    }
  }

  // Check that edges reference declared slot names
  for (const e of edges) {
    const fromStage = stages.find((s) => s.stageKey === e.from.stage);
    const toStage = stages.find((s) => s.stageKey === e.to.stage);
    if (fromStage && e.from.slot) {
      const hasSlot = fromStage.outputs.some((o) => o.name === e.from.slot);
      if (!hasSlot) {
        errors.push(
          `Edge from "${e.from.stage}.${e.from.slot}" — slot not declared in that stage's outputs.`,
        );
      }
    }
    if (toStage && e.to.slot) {
      const hasSlot = toStage.inputs.some((i) => i.name === e.to.slot);
      if (!hasSlot) {
        errors.push(
          `Edge to "${e.to.stage}.${e.to.slot}" — slot not declared in that stage's inputs.`,
        );
      }
    }
  }

  return errors;
}

// ── Graph assembly ────────────────────────────────────────────────────────────

function buildGraph(stages: StageFormEntry[], edges: EdgeDef[]): WorkflowGraph {
  const stagesMap: WorkflowGraph["stages"] = {};
  for (const s of stages) {
    stagesMap[s.stageKey] = stageFormEntryToNodeDef(s);
  }
  return { stages: stagesMap, edges };
}

// ── Load existing def into form state ─────────────────────────────────────────

function defToFormState(def: WorkflowDefFull): {
  stages: StageFormEntry[];
  edges: EdgeDef[];
} {
  const stages: StageFormEntry[] = Object.entries(def.graph.stages).map(([key, node]) => ({
    stageKey: key,
    inputs: node.inputs,
    outputs: node.outputs,
    config: {
      runtime: node.config.runtime ?? "claude-code",
      prompt_template_path: node.config.prompt_template_path ?? "",
      slot_bindings: node.config.slot_bindings ?? {},
      workdir: node.config.workdir ?? { from: "context", path: "/workdir" },
      session_name: node.config.session_name ?? "",
      model: node.config.model ?? null,
      effort: node.config.effort ?? null,
      worktree: node.config.worktree ?? null,
      pre_authorized_tools: node.config.pre_authorized_tools ?? [],
      yolo: node.config.yolo ?? false,
      fan_out: node.config.fan_out ?? null,
      gate_output: node.config.gate_output ?? null,
    },
  }));
  return { stages, edges: def.graph.edges };
}

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
      const { stages: s, edges: e } = defToFormState(cloneLoaded);
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
    setStages((prev) => prev.map((s, idx) => (idx === i ? { ...s, stageKey: newKey } : s)));
  };

  const removeStage = (i: number) => {
    setStages((prev) => prev.filter((_, idx) => idx !== i));
  };

  const validationErrors = useMemo(
    () => validateGraph(stages, edges, name),
    [stages, edges, name],
  );
  const graph = useMemo(() => buildGraph(stages, edges), [stages, edges]);
  const previewJson = useMemo(
    () => JSON.stringify({ name, version, graph }, null, 2),
    [name, version, graph],
  );

  const pending = createMutation.isPending;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (validationErrors.length > 0) return;
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
    <div className="flex flex-col gap-4" data-testid="or-def-editor">
      <header className="flex items-center gap-4">
        <button type="button" className={secondaryButtonClass} onClick={onBack}>
          Back
        </button>
        <h2 className="m-0 text-lg font-semibold text-[var(--text-primary)]">{title}</h2>
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
                key={i}
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

        {/* Right: live JSON preview */}
        <aside className="sticky top-4 flex flex-col gap-2">
          <span className="text-xs font-semibold uppercase text-[var(--text-muted)]">
            JSON Preview (POST body)
          </span>
          <pre
            className="max-h-[70vh] overflow-auto rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 font-mono text-xs text-[var(--text-secondary)]"
            data-testid="or-def-preview"
          >
            {previewJson}
          </pre>
        </aside>
      </div>
    </div>
  );
}
