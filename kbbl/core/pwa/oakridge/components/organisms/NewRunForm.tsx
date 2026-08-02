import { useEffect, useMemo, useState } from "react";
import {
  defaultRuntimeIdForConfig,
  runtimeDescriptorsForConfig,
  useServerConfig,
} from "../../../hooks/useServerConfig";
import type { RuntimeModelSelection } from "../../../types";
import { coerceSelection } from "../../../sidebar/AddSpecModal";
import {
  defaultWorkflowDefinitionId,
  sortWorkflowDefinitions,
} from "../../../lib/workflow-defs";
import { useOakridgeConfig } from "../../hooks/useOakridgeConfig";
import { useProjects } from "../../hooks/useProjects";
import { useWorkflowDefs } from "../../hooks/useWorkflowDefs";
import { useCreateRun } from "../../hooks/useCreateRun";
import type { RepositoryInputDraft } from "../../types";
import { validateRepositoryInputs } from "../../repository-inputs";
import { RoleModelPicker } from "../molecules/RoleModelPicker";
import { initialSelectionForRole } from "../../lib/runtime-selection";

const secondaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--border-muted)] bg-transparent px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:border-[var(--border-hover)]";
const primaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md bg-[var(--accent-blue)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";
const fieldLabelClass = "block text-xs font-medium text-[var(--text-muted)] mb-1";
const inputClass =
  "w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none";


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
  const [repositories, setRepositories] = useState<RepositoryInputDraft[]>([{ key: "repo", path: "" }]);
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

  // Sort defs: newest version first per name, then by name. Memoized so the
  // sort only runs when the server response changes.
  const sortedDefs = useMemo(() => {
    return sortWorkflowDefinitions(defsQuery.data ?? []);
  }, [defsQuery.data]);

  // The sorted list is newest-first within each workflow name, so its first
  // entry is the normal default workflow definition.
  useEffect(() => {
    if (workflowDefId) return;
    const defaultId = defaultWorkflowDefinitionId(sortedDefs);
    if (defaultId) setWorkflowDefId(defaultId);
  }, [sortedDefs, workflowDefId]);

  // A legacy project is a convenience preset for the first repository. It
  // does not constrain the run to that repository.
  useEffect(() => {
    if (!projectId) return;
    const project = projectsQuery.data?.find((p) => p.id === projectId);
    if (project) {
      const key = project.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "repo";
      setRepositories((current) => [
        { key, path: project.repo_dir },
        ...current.slice(1),
      ]);
    }
  }, [projectId, projectsQuery.data]);

  const coreUrl = configQuery.data?.core_url ?? "";
  const pending = createRun.isPending;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!workflowDefId) { setError("Select a workflow definition."); return; }
    const repositoryResult = validateRepositoryInputs(repositories);
    if (!repositoryResult.ok) { setError(repositoryResult.error.detail); return; }
    const normalizedRepositories = repositoryResult.repositories;
    if (!briefNotes.trim()) { setError("Brief notes are required."); return; }
    if (!coreUrl) { setError("oakridge core URL is not configured."); return; }
    try {
      const result = await createRun.mutateAsync({
        workflow_def_id: workflowDefId,
        project_id: projectId || null,
        context: {
          brief_notes: briefNotes.trim(),
          repositories: normalizedRepositories,
          worktree_path: normalizedRepositories[0].path,
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
            {!defsQuery.isPending && sortedDefs.length === 0 && (
              <option value="">No workflow definitions found</option>
            )}
            {sortedDefs.map((def) => (
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

        <fieldset className="flex flex-col gap-2 rounded-md border border-[var(--border-subtle)] p-3">
          <div className="flex items-center justify-between gap-3">
            <legend className={fieldLabelClass}>Repositories</legend>
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={pending}
              onClick={() => setRepositories((current) => [...current, { key: "", path: "" }])}
            >
              + Repository
            </button>
          </div>
          {repositories.map((repository, index) => (
            <div className="grid grid-cols-[minmax(7rem,0.35fr)_1fr_auto] gap-2" key={index}>
              <input
                type="text"
                className={inputClass}
                value={repository.key}
                onChange={(event) => setRepositories((current) => current.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, key: event.target.value } : item
                ))}
                disabled={pending}
                placeholder="api"
                aria-label={`Repository ${index + 1} key`}
                required
              />
              <input
                type="text"
                className={inputClass}
                value={repository.path}
                onChange={(event) => setRepositories((current) => current.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, path: event.target.value } : item
                ))}
                disabled={pending}
                placeholder="/absolute/path/to/repo"
                aria-label={`Repository ${index + 1} path`}
                required
              />
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={pending || repositories.length === 1}
                onClick={() => setRepositories((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                aria-label={`Remove repository ${index + 1}`}
              >
                Remove
              </button>
            </div>
          ))}
        </fieldset>

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
            isPending={pending}
          />
          <RoleModelPicker
            role="worker"
            selection={workerSelection}
            setSelection={setWorkerSelection}
            setRuntimeTouched={setWorkerRuntimeTouched}
            runtimeDescriptors={runtimeDescriptors}
            defaultRuntimeId={defaultRuntimeId}
            isPending={pending}
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
