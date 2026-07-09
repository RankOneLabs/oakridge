import { useEffect, useMemo, useState } from "react";
import { defaultPlannerModelForRuntime, defaultWorkerModelForRuntime, type RuntimeId } from "../../runtime";
import {
  defaultRuntimeIdForConfig,
  runtimeDescriptorsForConfig,
  useServerConfig,
} from "../hooks/useServerConfig";
import type { RuntimeDescriptor, RuntimeModelSelection } from "../types";
import { coerceSelection } from "../sidebar/AddSpecModal";
import { useOakridgeConfig, useProjects, useWorkflowDefs, useCreateRun } from "./hooks";

const secondaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--border-muted)] bg-transparent px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:border-[var(--border-hover)]";
const primaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md bg-[var(--accent-blue)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";
const fieldLabelClass = "block text-xs font-medium text-[var(--text-muted)] mb-1";
const inputClass =
  "w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none";

type Role = "planner" | "worker";
type SetSelection = (
  value: RuntimeModelSelection | ((current: RuntimeModelSelection) => RuntimeModelSelection),
) => void;

function isModelAllowed(runtime: RuntimeDescriptor, model: string): boolean {
  return runtime.models.some((option) => option.value === model);
}

function getRoleDefaultModel(role: Role, runtime: RuntimeDescriptor): string {
  const preferred =
    role === "planner"
      ? defaultPlannerModelForRuntime(runtime.id)
      : defaultWorkerModelForRuntime(runtime.id);
  if (isModelAllowed(runtime, preferred)) return preferred;
  return runtime.models[0]?.value ?? preferred;
}

function getRuntimeForSelection(
  runtimeDescriptors: RuntimeDescriptor[],
  defaultRuntimeId: RuntimeId,
  runtimeId: RuntimeId,
): RuntimeDescriptor {
  return (
    runtimeDescriptors.find((r) => r.id === runtimeId) ??
    runtimeDescriptors.find((r) => r.id === defaultRuntimeId) ??
    runtimeDescriptors[0]
  );
}

function initialSelectionForRole(
  role: Role,
  runtimeDescriptors: RuntimeDescriptor[],
  defaultRuntimeId: RuntimeId,
): RuntimeModelSelection {
  const runtime = getRuntimeForSelection(runtimeDescriptors, defaultRuntimeId, defaultRuntimeId);
  return { runtime: runtime.id, model: getRoleDefaultModel(role, runtime) };
}

interface RoleModelPickerProps {
  role: Role;
  selection: RuntimeModelSelection;
  setSelection: SetSelection;
  setRuntimeTouched: (v: boolean) => void;
  runtimeDescriptors: RuntimeDescriptor[];
  defaultRuntimeId: RuntimeId;
  pending: boolean;
}

function RoleModelPicker({
  role,
  selection,
  setSelection,
  setRuntimeTouched,
  runtimeDescriptors,
  defaultRuntimeId,
  pending,
}: RoleModelPickerProps) {
  const roleLabel = role === "planner" ? "Planner" : "Worker";
  const runtime = getRuntimeForSelection(runtimeDescriptors, defaultRuntimeId, selection.runtime);
  const modelOptions = runtime.models;

  return (
    <section className="flex flex-col gap-2 rounded-md border border-[var(--border-subtle)] p-3">
      <div className="text-xs font-semibold uppercase text-[var(--text-muted)]">{roleLabel}</div>
      <label className="flex flex-col gap-1">
        <span className={fieldLabelClass}>Runtime</span>
        <select
          className={inputClass}
          value={selection.runtime}
          onChange={(e) => {
            const nextId = e.target.value as RuntimeId;
            const nextRuntime = getRuntimeForSelection(runtimeDescriptors, defaultRuntimeId, nextId);
            setRuntimeTouched(true);
            setSelection({ runtime: nextRuntime.id, model: getRoleDefaultModel(role, nextRuntime) });
          }}
          disabled={pending}
          aria-label={`${roleLabel} runtime`}
        >
          {runtimeDescriptors.map((r) => (
            <option key={r.id} value={r.id}>{r.label}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className={fieldLabelClass}>Model</span>
        {modelOptions.length > 0 ? (
          <select
            className={inputClass}
            value={selection.model}
            onChange={(e) => setSelection((cur) => ({ ...cur, model: e.target.value }))}
            disabled={pending}
            aria-label={`${roleLabel} model`}
          >
            {modelOptions.map((opt) => (
              <option key={opt.value || "default"} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            className={inputClass}
            value={selection.model}
            onChange={(e) => setSelection((cur) => ({ ...cur, model: e.target.value }))}
            disabled={pending}
            aria-label={`${roleLabel} model`}
            spellCheck={false}
          />
        )}
      </label>
      {runtime.efforts.length > 0 && (
        <label className="flex flex-col gap-1">
          <span className={fieldLabelClass}>Effort</span>
          <select
            className={inputClass}
            value={selection.effort ?? ""}
            onChange={(e) =>
              setSelection((cur) => ({ ...cur, effort: e.target.value || undefined }))
            }
            disabled={pending}
            aria-label={`${roleLabel} effort`}
          >
            {[{ value: "", label: "default" }, ...runtime.efforts].map((opt) => (
              <option key={opt.value || "default"} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>
      )}
    </section>
  );
}

interface NewRunFormProps {
  onBack: () => void;
  onCreated: (runId: string) => void;
}

export function NewRunForm({ onBack, onCreated }: NewRunFormProps) {
  const configQuery = useOakridgeConfig();
  const projectsQuery = useProjects();
  const defsQuery = useWorkflowDefs();
  const createRun = useCreateRun();

  const serverConfig = useServerConfig();
  const runtimeDescriptors = useMemo(() => runtimeDescriptorsForConfig(serverConfig), [serverConfig]);
  const defaultRuntimeId = useMemo(() => defaultRuntimeIdForConfig(serverConfig), [serverConfig]);
  const runtimeKey = useMemo(
    () =>
      runtimeDescriptors
        .map((r) => `${r.id}:${r.models.map((m) => m.value).join(",")}`)
        .join("\0"),
    [runtimeDescriptors],
  );

  const [briefNotes, setBriefNotes] = useState("");
  const [worktreePath, setWorktreePath] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [workflowDefId, setWorkflowDefId] = useState<string>("");
  const [plannerSelection, setPlannerSelection] = useState<RuntimeModelSelection>(() =>
    initialSelectionForRole("planner", runtimeDescriptors, defaultRuntimeId),
  );
  const [workerSelection, setWorkerSelection] = useState<RuntimeModelSelection>(() =>
    initialSelectionForRole("worker", runtimeDescriptors, defaultRuntimeId),
  );
  const [plannerRuntimeTouched, setPlannerRuntimeTouched] = useState(false);
  const [workerRuntimeTouched, setWorkerRuntimeTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPlannerSelection((cur) =>
      coerceSelection("planner", cur, runtimeDescriptors, defaultRuntimeId, plannerRuntimeTouched),
    );
  }, [defaultRuntimeId, plannerRuntimeTouched, runtimeKey, runtimeDescriptors]);

  useEffect(() => {
    setWorkerSelection((cur) =>
      coerceSelection("worker", cur, runtimeDescriptors, defaultRuntimeId, workerRuntimeTouched),
    );
  }, [defaultRuntimeId, runtimeKey, runtimeDescriptors, workerRuntimeTouched]);

  // Auto-select first workflow def when defs load
  useEffect(() => {
    if (defsQuery.data && defsQuery.data.length > 0 && !workflowDefId) {
      setWorkflowDefId(defsQuery.data[0].id);
    }
  }, [defsQuery.data, workflowDefId]);

  // When project is selected, populate worktree_path from repo_dir
  useEffect(() => {
    if (!projectId) return;
    const project = projectsQuery.data?.find((p) => p.id === projectId);
    if (project) setWorktreePath(project.repo_dir);
  }, [projectId, projectsQuery.data]);

  const coreUrl = configQuery.data?.core_url ?? "";
  const pending = createRun.isPending;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!workflowDefId) { setError("Select a workflow definition."); return; }
    if (!worktreePath.trim()) { setError("Worktree path is required."); return; }
    if (!briefNotes.trim()) { setError("Brief notes are required."); return; }
    if (!coreUrl) { setError("oakridge core URL is not configured."); return; }
    try {
      const result = await createRun.mutateAsync({
        workflow_def_id: workflowDefId,
        project_id: projectId || null,
        context: {
          brief_notes: briefNotes.trim(),
          worktree_path: worktreePath.trim(),
          oakridge_url: coreUrl,
          planner_model: plannerSelection.model,
          worker_model: workerSelection.model,
          ...(workerSelection.effort ? { worker_effort: workerSelection.effort } : {}),
        },
      });
      onCreated(result.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create run");
    }
  };

  return (
    <div className="flex flex-col gap-5" data-testid="or-new-run-form">
      <header className="flex items-center gap-4">
        <button type="button" className={secondaryButtonClass} onClick={onBack}>Back</button>
        <h2 className="m-0 text-lg font-semibold text-[var(--text-primary)]">New Workflow Run</h2>
      </header>

      <form className="flex flex-col gap-4" onSubmit={(e) => { void onSubmit(e); }}>
        <label className="flex flex-col gap-1">
          <span className={fieldLabelClass}>Workflow Definition</span>
          <select
            className={inputClass}
            value={workflowDefId}
            onChange={(e) => setWorkflowDefId(e.target.value)}
            disabled={pending || defsQuery.isPending}
            required
          >
            {defsQuery.isPending && <option value="">Loading…</option>}
            {!defsQuery.isPending && defsQuery.data?.length === 0 && (
              <option value="">No workflow definitions found</option>
            )}
            {defsQuery.data?.map((def) => (
              <option key={def.id} value={def.id}>
                {def.name} v{def.version}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={fieldLabelClass}>Project (optional)</span>
          <select
            className={inputClass}
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            disabled={pending || projectsQuery.isPending}
          >
            <option value="">— none —</option>
            {projectsQuery.data?.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={fieldLabelClass}>Worktree Path</span>
          <input
            type="text"
            className={inputClass}
            value={worktreePath}
            onChange={(e) => setWorktreePath(e.target.value)}
            disabled={pending}
            placeholder="/path/to/repo"
            required
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={fieldLabelClass}>Brief Notes</span>
          <textarea
            className={`${inputClass} min-h-24 resize-y`}
            value={briefNotes}
            onChange={(e) => setBriefNotes(e.target.value)}
            disabled={pending}
            placeholder="Describe what to build…"
            required
            rows={4}
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <RoleModelPicker
            role="planner"
            selection={plannerSelection}
            setSelection={setPlannerSelection}
            setRuntimeTouched={setPlannerRuntimeTouched}
            runtimeDescriptors={runtimeDescriptors}
            defaultRuntimeId={defaultRuntimeId}
            pending={pending}
          />
          <RoleModelPicker
            role="worker"
            selection={workerSelection}
            setSelection={setWorkerSelection}
            setRuntimeTouched={setWorkerRuntimeTouched}
            runtimeDescriptors={runtimeDescriptors}
            defaultRuntimeId={defaultRuntimeId}
            pending={pending}
          />
        </div>

        {error && (
          <div
            className="rounded-md border border-[var(--danger-card-border)] bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger-fg)]"
            role="alert"
          >
            {error}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button type="button" className={secondaryButtonClass} onClick={onBack} disabled={pending}>
            Cancel
          </button>
          <button type="submit" className={primaryButtonClass} disabled={pending || !workflowDefId}>
            {pending ? "Starting…" : "Start Run"}
          </button>
        </div>
      </form>
    </div>
  );
}
