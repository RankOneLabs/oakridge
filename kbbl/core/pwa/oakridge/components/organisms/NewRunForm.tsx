import { TextInput } from "../../../components/atoms/TextInput";
import { Select } from "../../../components/atoms/Select";
import { useInstallStatus } from "../../hooks/useInstallStatus";
import { selectLaunchBlock } from "../../state/install-status";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  defaultRuntimeIdForConfig,
  runtimeDescriptorsForConfig,
  useServerConfig,
} from "../../../hooks/useServerConfig";
import {
  defaultWorkflowDefinitionId,
  sortWorkflowDefinitions,
} from "../../../lib/workflow-defs";
import { useProjects } from "../../hooks/useProjects";
import { useWorkflowDefs } from "../../hooks/useWorkflowDefs";
import { useOperatorDefinition } from "../../hooks/useOperatorDefinition";
import { useAgentSessionSelections } from "../../hooks/useAgentSessionSelections";
import { useCreateRun } from "../../hooks/useCreateRun";
import type { RepositoryInputDraft } from "../../launch-types";
import type { Project } from "../../project-types";
import { repositoryDraftFromProject } from "../../repository-inputs";
import { SessionModelFields } from "../molecules/SessionModelFields";
import { selectAgentSessionTargets, selectLaunchSessionSettings, selectRoleChoiceTargets, selectSessionKeysFromRoleKeys,
  selectSessionSelectionsFromRoles, type SessionModelMode } from "../../lib/agent-session-targets";
import { selectRequestIdentity, type PendingRequestIdentity } from "../../lib/request-identity";
import { randomUuid } from "../../../lib/random-uuid";
import { RepositoryLaunchFields } from "../molecules/RepositoryLaunchFields";
import type { FinalMergePolicy } from "../../run-types";
import { BriefNotesField } from "../molecules/BriefNotesField";
import { StudySliceFields } from "../molecules/StudySliceFields";
import { readBriefNotesFile, type BriefNotesSource } from "../../lib/brief-notes";
import { WorkflowInputFields } from "../molecules/WorkflowInputFields";
import { DEFAULT_STUDY_SLICE_DRAFT, selectLaunchInputSchema, selectWorkflowLaunchInput, type LaunchInputDraft } from "../../lib/workflow-launch-input";
import { AutomaticGradingField } from "../molecules/AutomaticGradingField";
import { Button } from "../../../components/atoms/Button";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import { FormField } from "../molecules/FormField";
import { PageHeader } from "../molecules/PageHeader";

interface NewRunFormProps {
  onBack: () => void;
  onCreated: (runId: string) => void;
}

export function NewRunForm({ onBack, onCreated }: NewRunFormProps) {
  const projectsQuery = useProjects();
  const defsQuery = useWorkflowDefs();
  const createRun = useCreateRun();
  const pendingLaunch = useRef<PendingRequestIdentity | null>(null);

  const serverConfig = useServerConfig();
  const runtimeDescriptors = useMemo(() => runtimeDescriptorsForConfig(serverConfig), [serverConfig]);
  const defaultRuntimeId = useMemo(() => defaultRuntimeIdForConfig(serverConfig), [serverConfig]);

  const [draft, setDraft] = useState<LaunchInputDraft>({});
  const [epicTitle, setEpicTitle] = useState("");
  const [finalMergePolicy, setFinalMergePolicy] = useState<FinalMergePolicy>("guarded");
  const [briefNotes, setBriefNotes] = useState("");
  const [briefNotesSource, setBriefNotesSource] = useState<BriefNotesSource>({ kind: "typed" });
  const [isReadingBrief, setIsReadingBrief] = useState(false);
  const [studySlice, setStudySlice] = useState(DEFAULT_STUDY_SLICE_DRAFT);
  const [repositories, setRepositories] = useState<RepositoryInputDraft[]>([{ key: "repo", path: "", forge_owner: "", forge_name: "", integration_branch: "main" }]);
  const [projectId, setProjectId] = useState<string>("");
  const [isGradingEnabled, setIsGradingEnabled] = useState(false);
  const [workflowDefId, setWorkflowDefId] = useState<string>("");
  const installStatus = useInstallStatus();
  const launchBlock = selectLaunchBlock(installStatus.data, workflowDefId);
  const definitionQuery = useOperatorDefinition(workflowDefId);
  const sessionTargets = useMemo(() => definitionQuery.data ? selectAgentSessionTargets(definitionQuery.data.workflow, definitionQuery.data.graph, definitionQuery.data.worker_names) : [], [definitionQuery.data]);
  const inputSchema = definitionQuery.data ? selectLaunchInputSchema(definitionQuery.data.bundle) : null;
  const hasEpicFields = inputSchema?.form === "development" || inputSchema?.form === "study";
  const sessionChoices = useAgentSessionSelections(sessionTargets, runtimeDescriptors, defaultRuntimeId);
  const roleTargets = useMemo(() => selectRoleChoiceTargets(sessionTargets), [sessionTargets]);
  const roleChoices = useAgentSessionSelections(roleTargets, runtimeDescriptors, defaultRuntimeId);
  const [modelMode, setModelMode] = useState<SessionModelMode>("by_role");
  const sessionSelectionsFromRoles = () => selectSessionSelectionsFromRoles(sessionTargets,
    Object.fromEntries(roleTargets.map((target) => [target.key, roleChoices.selectionFor(target)])));
  const [error, setError] = useState<string | null>(null);

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

  const pending = createRun.isPending;

  const onAddRepository = (project: Project) => {
    setRepositories((current) => [...current, repositoryDraftFromProject(project, {
      key: "", path: "", forge_owner: "", forge_name: "", integration_branch: "main",
    })]);
  };

  const onBriefNotesFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    setIsReadingBrief(true);
    const result = await readBriefNotesFile(file);
    setIsReadingBrief(false);
    if (!result.ok) {
      setBriefNotes("");
      setBriefNotesSource({ kind: "file", file_name: "" });
      setError(result.error.detail);
      return;
    }
    setBriefNotes(result.value.text);
    setBriefNotesSource({ kind: "file", file_name: result.value.file_name });
  };

  // Per-session choices always start from the current planner and worker
  // choices, so switching shows exactly what by-role mode would launch.
  const onModelModeChange = (mode: SessionModelMode) => {
    if (mode === modelMode) return;
    if (mode === "by_session") {
      sessionChoices.seed(sessionSelectionsFromRoles(), selectSessionKeysFromRoleKeys(sessionTargets, roleChoices.touched));
    }
    setModelMode(mode);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (launchBlock) { setError(launchBlock.error.detail); return; }
    if (!workflowDefId) { setError("Select a workflow definition."); return; }
    if (!definitionQuery.data || definitionQuery.data.definition_id !== workflowDefId) { setError("Wait for the workflow's agent sessions to load."); return; }
    if (!inputSchema) { setError("This workflow does not provide a record input schema."); return; }
    if (isReadingBrief) return;
    const workflowInput = selectWorkflowLaunchInput(inputSchema, {
      fields: draft, studySlice,
      epic: { title: epicTitle, policy: finalMergePolicy, notes: briefNotes, source: briefNotesSource, repositories },
    });
    if (!workflowInput.ok) { setError(workflowInput.error.detail); return; }
    const sessionSettings = selectLaunchSessionSettings(sessionTargets, modelMode === "by_role"
      ? sessionSelectionsFromRoles()
      : Object.fromEntries(sessionTargets.map((target) => [target.key, sessionChoices.selectionFor(target)])));
    if (!sessionSettings.ok) { setError(sessionSettings.error.detail); return; }
    try {
      const request = {
        workflow_def_id: workflowDefId,
        project_id: projectId || null,
        session_settings: sessionSettings.value,
        grading_enabled: isGradingEnabled,
        workflow_input: workflowInput.value,
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
        summary="Choose the workflow, repositories, operating brief, and the agent models."
      />

      <form className="or-form-card flex flex-col gap-4" onSubmit={(e) => { void onSubmit(e); }}>
        {hasEpicFields && <>
          <FormField label="Epic title">
            <TextInput type="text" value={epicTitle} onChange={(event) => setEpicTitle(event.target.value)} disabled={pending} placeholder="Ship account recovery" required />
          </FormField>
          <FormField label="Final merge policy" hint="Choose guarded for normal GitHub workflows. External confirmation leaves final integration completion to an outside operator or system.">
            <Select value={finalMergePolicy} onChange={(event) => setFinalMergePolicy(event.target.value === "external_confirmation" ? "external_confirmation" : "guarded")} disabled={pending}>
              <option value="guarded">Guarded — Oakridge verifies the final merge</option>
              <option value="external_confirmation">External confirmation — another system confirms it</option>
            </Select>
          </FormField>
        </>}
        <FormField label="Workflow Definition">
          <Select
            value={workflowDefId}
            onChange={(e) => { setWorkflowDefId(e.target.value); setDraft({}); setError(null); }}
            disabled={pending || isReadingBrief || defsQuery.isPending}
            required
          >
            {defsQuery.isPending && <option value="">Loading…</option>}
            {!defsQuery.isPending && sortedDefs.length === 0 && (
              <option value="">No workflow definitions found</option>
            )}
            {sortedDefs.map((def) => (
              <option key={def.id} value={def.id}>
                {def.name}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField label="Project (optional)">
          <Select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            disabled={pending || projectsQuery.isPending}
          >
            <option value="">— none —</option>
            {projectsQuery.data?.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </Select>
        </FormField>

        {hasEpicFields && <RepositoryLaunchFields
          repositories={repositories}
          setRepositories={setRepositories}
          projects={projectsQuery.data ?? []}
          onAddRepository={onAddRepository}
          isLoadingProjects={projectsQuery.isPending}
          disabled={pending}
        />}
        {hasEpicFields && <BriefNotesField
          notes={briefNotes}
          setNotes={setBriefNotes}
          source={briefNotesSource}
          setSource={setBriefNotesSource}
          onFileChange={(event) => { void onBriefNotesFileChange(event); }}
          disabled={pending || isReadingBrief}
        />}
        {inputSchema?.form === "study" && <StudySliceFields draft={studySlice} onChange={setStudySlice} disabled={pending} />}
        {inputSchema && <WorkflowInputFields fields={inputSchema.additionalFields}
          draft={draft} onChange={(key, value) => setDraft((current) => ({ ...current, [key]: value }))} disabled={pending} />}

        {definitionQuery.isPending && <div>Loading agent sessions…</div>}
        {definitionQuery.isError && <FeedbackMessage tone="danger">Could not load agent sessions: {definitionQuery.error.message}</FeedbackMessage>}
        {sessionTargets.length > 0 && <SessionModelFields
          mode={modelMode}
          onModeChange={onModelModeChange}
          roleTargets={roleTargets}
          roleChoices={roleChoices}
          sessionTargets={sessionTargets}
          sessionChoices={sessionChoices}
          runtimes={{ descriptors: runtimeDescriptors, default_id: defaultRuntimeId }}
          disabled={pending}
        />}

        <AutomaticGradingField is_enabled={isGradingEnabled} onChange={setIsGradingEnabled} disabled={pending} />

        {launchBlock && <FeedbackMessage tone="danger">{launchBlock.error.detail} Fix: {launchBlock.error.fix}</FeedbackMessage>}
        {error && <FeedbackMessage tone="danger">{error}</FeedbackMessage>}

        <div className="flex justify-end gap-3">
          <Button onClick={onBack} disabled={pending}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={Boolean(launchBlock) || isReadingBrief || pending || !workflowDefId || !definitionQuery.data || !inputSchema}>
            {pending ? "Starting…" : "Start Run"}
          </Button>
        </div>
      </form>
    </div>
  );
}
