import { useState } from "react";
import { useCreateProject } from "../../hooks/useCreateProject";
import { useProjects } from "../../hooks/useProjects";
import { useUpdateProject } from "../../hooks/useUpdateProject";
import { Button } from "../atoms/Button";
import { FeedbackMessage } from "../atoms/FeedbackMessage";
import { FormField, formControlClass } from "../molecules/FormField";
import { PageHeader } from "../molecules/PageHeader";

interface CreateProjectFormProps {
  onBack: () => void;
  onCreated: () => void;
}

export function CreateProjectForm({ onBack, onCreated }: CreateProjectFormProps) {
  const [name, setName] = useState("");
  const [repoDir, setRepoDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const projects = useProjects();
  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const pending = createProject.isPending || updateProject.isPending;

  const onSelectProject = (id: string) => {
    setProjectId(id);
    const project = projects.data?.find((candidate) => candidate.id === id);
    setName(project?.name ?? "");
    setRepoDir(project?.repo_dir ?? "");
    setError(null);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError("Project name is required."); return; }
    if (!repoDir.trim()) { setError("Repository path is required."); return; }
    try {
      const input = { name: name.trim(), repo_dir: repoDir.trim() };
      if (projectId) await updateProject.mutateAsync({ id: projectId, ...input });
      else await createProject.mutateAsync(input);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save project");
    }
  };

  return (
    <div className="or-page or-page--form" data-testid="or-create-project">
      <PageHeader
        backAction={<Button onClick={onBack}>Back</Button>}
        eyebrow="Repository context"
        title="Manage projects"
        summary="Register a repository or correct an existing project's name and path."
      />

      <form className="or-form-card flex flex-col gap-4" onSubmit={(e) => { void onSubmit(e); }}>
        <FormField label="Existing project">
          <select className={formControlClass} value={projectId} onChange={(event) => onSelectProject(event.target.value)} disabled={pending || projects.isPending}>
            <option value="">Create a new project</option>
            {projects.data?.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </FormField>
        <FormField label="Name">
          <input
            type="text"
            className={formControlClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={pending}
            placeholder="my-project"
            required
          />
        </FormField>

        <FormField label="Repository Path">
          <input
            type="text"
            className={formControlClass}
            value={repoDir}
            onChange={(e) => setRepoDir(e.target.value)}
            disabled={pending}
            placeholder="/path/to/repo"
            required
          />
        </FormField>

        {error && <FeedbackMessage tone="danger">{error}</FeedbackMessage>}

        <div className="flex justify-end gap-3">
          <Button onClick={onBack} disabled={pending}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Saving…" : projectId ? "Update Project" : "Create Project"}
          </Button>
        </div>
      </form>
    </div>
  );
}
