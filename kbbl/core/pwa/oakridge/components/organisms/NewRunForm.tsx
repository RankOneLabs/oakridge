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
import type { FinalMergePolicy, RepositoryInputDraft } from "../../types";
import { validateRepositoryInputs } from "../../repository-inputs";
import { RoleModelPicker } from "../molecules/RoleModelPicker";
import { initialSelectionForRole } from "../../lib/runtime-selection";
import { buildEpicProfile } from "../../lib/launch-config";
import { RepositoryLaunchFields } from "../molecules/RepositoryLaunchFields";

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

  const [epicTitle, setEpicTitle] = useState("");
  const [finalMergePolicy, setFinalMergePolicy] = useState<FinalMergePolicy>("guarded");
  const [briefNotes, setBriefNotes] = useState("");
  const [repositories, setRepositories] = useState<RepositoryInputDraft[]>([{ key: "repo", path: "", forge_owner: "", forge_name: "", base_branch: "main" }]);
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
        { ...current[0], key, path: project.repo_dir },
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
    const epicProfile = buildEpicProfile(epicTitle, finalMergePolicy, normalizedRepositories);
    if (!epicProfile) { setError("Epic title must include a letter or number."); return; }
    if (!briefNotes.trim()) { setError("Brief notes are required."); return; }
    if (!coreUrl) { setError("oakridge core URL is not configured."); return; }
    try {
      const result = await createRun.mutateAsync({
        workflow_def_id: workflowDefId,
        project_id: projectId || null,
        context: {
          brief_notes: briefNotes.trim(),
          repositories: normalizedRepositories.map(({ key, path }) => ({ key, path })),
          worktree_path: normalizedRepositories[0].path,
          oakridge_url: coreUrl,
          planner_runtime: plannerSelection.runtime,
          planner_model: plannerSelection.model,
          ...(plannerSelection.effort ? { planner_effort: plannerSelection.effort } : {}),
          worker_runtime: workerSelection.runtime,
          worker_model: workerSelection.model,
          ...(workerSelection.effort ? { worker_effort: workerSelection.effort } : {}),
        },
        epic_profile: epicProfile,
      });
      onCreated(result.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create run");
    }
  };

  return (
    <div className="or-page or-page--form" data-testid="or-new-run-form">
      <header className="or-page-header or-page-header--back">
        <button type="button" className={secondaryButtonClass} onClick={onBack}>Back</button>
        <div><span className="or-page-kicker">New execution</span><h2 className="or-page-title">Start a workflow run</h2><p className="or-page-summary">Choose the workflow, repositories, operating brief, and agent roles.</p></div>
      </header>

      <form className="or-form-card flex flex-col gap-4" onSubmit={(e) => { void onSubmit(e); }}>
        <label className="flex flex-col gap-1">
          <span className={fieldLabelClass}>Epic title</span>
          <input type="text" className={inputClass} value={epicTitle} onChange={(event) => setEpicTitle(event.target.value)} disabled={pending} placeholder="Ship account recovery" required />
        </label>
        <label className="flex flex-col gap-1">
          <span className={fieldLabelClass}>Final merge policy</span>
          <select className={inputClass} value={finalMergePolicy} onChange={(event) => setFinalMergePolicy(event.target.value === "external_confirmation" ? "external_confirmation" : "guarded")} disabled={pending}>
            <option value="guarded">Guarded — Oakridge verifies the final merge</option>
            <option value="external_confirmation">External confirmation — another system confirms it</option>
          </select>
          <span className="text-xs leading-relaxed text-[var(--text-muted)]">Choose guarded for normal GitHub workflows. External confirmation leaves final integration completion to an outside operator or system.</span>
        </label>
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

        <RepositoryLaunchFields repositories={repositories} setRepositories={setRepositories} disabled={pending} />

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

        <div className="or-role-grid">
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
