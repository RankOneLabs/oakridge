import { useEffect, useMemo, useRef, useState } from "react";
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
import { repositoryDraftFromProject, validateRepositoryInputs } from "../../repository-inputs";
import { RoleModelPicker } from "../molecules/RoleModelPicker";
import { initialSelectionForRole } from "../../lib/runtime-selection";
import { buildEpicProfile, buildRunExecutionContext } from "../../lib/launch-config";
import { selectRequestIdentity, type PendingRequestIdentity } from "../../lib/request-identity";
import { randomUuid } from "../../../lib/random-uuid";
import { RepositoryLaunchFields } from "../molecules/RepositoryLaunchFields";
import { BriefNotesField } from "../molecules/BriefNotesField";
import { readBriefNotesFile, selectMissingBriefNotesDetail, type BriefNotesSource } from "../../lib/brief-notes";
import { Button } from "../atoms/Button";
import { FeedbackMessage } from "../atoms/FeedbackMessage";
import { FormField, formControlClass } from "../molecules/FormField";
import { PageHeader } from "../molecules/PageHeader";


interface NewRunFormProps {
  onBack: () => void;
  onCreated: (runId: string) => void;
}

export function NewRunForm({ onBack, onCreated }: NewRunFormProps) {
  const configQuery = useOakridgeConfig();
  const projectsQuery = useProjects();
  const defsQuery = useWorkflowDefs();
  const createRun = useCreateRun();
  const pendingLaunch = useRef<PendingRequestIdentity | null>(null);

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
  // A brief is often already written down. Typed or loaded, what the run
  // receives is the same string — the source only decides which control the
  // operator gets, and is dropped at submit.
  const [briefNotesSource, setBriefNotesSource] = useState<BriefNotesSource>({ kind: "typed" });
  const [repositories, setRepositories] = useState<RepositoryInputDraft[]>([{ key: "repo", path: "", forge_owner: "", forge_name: "", integration_branch: "main" }]);
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
      setRepositories((current) => [
        repositoryDraftFromProject(project, current[0]),
        ...current.slice(1),
      ]);
    }
  }, [projectId, projectsQuery.data]);

  const coreUrl = configQuery.data?.core_url ?? "";
  const pending = createRun.isPending;

  // The input is cleared afterwards so picking the same file twice still fires
  // a change event — otherwise a failed read cannot be retried without first
  // choosing some other file.
  const onBriefNotesFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    const result = await readBriefNotesFile(file);
    if (!result.ok) {
      setBriefNotes("");
      setBriefNotesSource({ kind: "file", file_name: "" });
      setError(result.error.detail);
      return;
    }
    setBriefNotes(result.value.text);
    setBriefNotesSource({ kind: "file", file_name: result.value.file_name });
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!workflowDefId) { setError("Select a workflow definition."); return; }
    const repositoryResult = validateRepositoryInputs(repositories);
    if (!repositoryResult.ok) { setError(repositoryResult.error.detail); return; }
    const normalizedRepositories = repositoryResult.repositories;
    const epicProfile = buildEpicProfile(epicTitle, finalMergePolicy, normalizedRepositories);
    if (!epicProfile) { setError("Epic title must include a letter or number."); return; }
    if (!briefNotes.trim()) { setError(selectMissingBriefNotesDetail(briefNotesSource)); return; }
    if (!coreUrl) { setError("oakridge core URL is not configured."); return; }
    const contextResult = buildRunExecutionContext({
      brief_notes: briefNotes.trim(),
      base_branch: epicProfile.base_branch ?? `epic/${epicProfile.slug}`,
      repositories: normalizedRepositories.map(({ key, path, integration_branch }) => ({ key, path, integration_branch })),
      oakridge_url: coreUrl,
      planner: plannerSelection,
      worker: workerSelection,
    });
    if (!contextResult.ok) { setError(contextResult.error.detail); return; }
    try {
      const request = {
        workflow_def_id: workflowDefId,
        project_id: projectId || null,
        context: contextResult.value,
        epic_profile: epicProfile,
      };
      pendingLaunch.current = selectRequestIdentity(pendingLaunch.current, JSON.stringify(request), randomUuid);
      const result = await createRun.mutateAsync({ request, idempotency_key: pendingLaunch.current.idempotency_key });
      pendingLaunch.current = null;
      onCreated(result.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create run");
    }
  };

  return (
    <div className="or-page or-page--form" data-testid="or-new-run-form">
      <PageHeader
        backAction={<Button onClick={onBack}>Back</Button>}
        eyebrow="New execution"
        title="Start a workflow run"
        summary="Choose the workflow, repositories, operating brief, and agent roles."
      />

      <form className="or-form-card flex flex-col gap-4" onSubmit={(e) => { void onSubmit(e); }}>
        <FormField label="Epic title">
          <input type="text" className={formControlClass} value={epicTitle} onChange={(event) => setEpicTitle(event.target.value)} disabled={pending} placeholder="Ship account recovery" required />
        </FormField>
        <FormField label="Final merge policy" hint="Choose guarded for normal GitHub workflows. External confirmation leaves final integration completion to an outside operator or system.">
          <select className={formControlClass} value={finalMergePolicy} onChange={(event) => setFinalMergePolicy(event.target.value === "external_confirmation" ? "external_confirmation" : "guarded")} disabled={pending}>
            <option value="guarded">Guarded — Oakridge verifies the final merge</option>
            <option value="external_confirmation">External confirmation — another system confirms it</option>
          </select>
        </FormField>
        <FormField label="Workflow Definition">
          <select
            className={formControlClass}
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
        </FormField>

        <FormField label="Project (optional)">
          <select
            className={formControlClass}
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            disabled={pending || projectsQuery.isPending}
          >
            <option value="">— none —</option>
            {projectsQuery.data?.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </FormField>

        <RepositoryLaunchFields repositories={repositories} setRepositories={setRepositories} disabled={pending} />

        <BriefNotesField
          notes={briefNotes}
          setNotes={setBriefNotes}
          source={briefNotesSource}
          setSource={setBriefNotesSource}
          onFileChange={(event) => { void onBriefNotesFileChange(event); }}
          disabled={pending}
        />

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

        {error && <FeedbackMessage tone="danger">{error}</FeedbackMessage>}

        <div className="flex justify-end gap-3">
          <Button onClick={onBack} disabled={pending}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={pending || !workflowDefId}>
            {pending ? "Starting…" : "Start Run"}
          </Button>
        </div>
      </form>
    </div>
  );
}
