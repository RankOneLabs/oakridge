import { queryKeys } from "../queryKeys";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createOperatorProject, fetchOperatorProjects, updateOperatorProject } from "../client";
import { Button } from "../../components/atoms/Button";
import type { OperatorProjectView } from "../operator-contracts";
import { EMPTY_PROJECT_FORM, selectProjectDraft, type ProjectFormValues } from "../lib/project-draft";

const formValuesOf = (project: OperatorProjectView): ProjectFormValues => ({ name: project.name, repo_dir: project.repo_dir,
  owner: project.forge_repository?.owner ?? "", repository: project.forge_repository?.name ?? "", integration_branch: project.integration_branch ?? "" });

interface Props { readonly onBack: () => void }
export function OperatorProjectsView({ onBack }: Props) {
  const client = useQueryClient();
  const projects = useQuery({ queryKey: queryKeys.projects, queryFn: fetchOperatorProjects });
  const [editing, setEditing] = useState<string | null>(null);
  const [values, setValues] = useState<ProjectFormValues>(EMPTY_PROJECT_FORM);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const field = (key: keyof ProjectFormValues, label: string, required = false) => <label className="flex flex-col gap-1">{label}
    <input type="text" value={values[key]} required={required} onChange={(event) => setValues({ ...values, [key]: event.target.value })} /></label>;
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null); setIsSaving(true);
    try {
      const draft = selectProjectDraft(values);
      if (editing === null) await createOperatorProject(draft); else await updateOperatorProject(editing, draft);
      setEditing(null); setValues(EMPTY_PROJECT_FORM);
      void client.invalidateQueries({ queryKey: queryKeys.projects });
    } catch (cause) { setError(String(cause)); } finally { setIsSaving(false); }
  };
  return <main className="or-page" data-testid="or-projects">
    <header className="or-page-header"><Button variant="secondary" onClick={onBack}>Back</Button><h1 className="or-page-title">Projects</h1></header>
    {projects.isError && <p role="alert">{String(projects.error)}</p>}
    {projects.data?.length === 0 && <p>No projects yet.</p>}
    <ul>{projects.data?.map((project) => <li key={project.id}>
      <strong>{project.name}</strong> · <code>{project.repo_dir}</code>
      {project.forge_repository && <span> · {project.forge_repository.owner}/{project.forge_repository.name}</span>}
      {project.integration_branch && <span> · {project.integration_branch}</span>}{" "}
      <Button variant="secondary" onClick={() => { setEditing(project.id); setValues(formValuesOf(project)); }}>Edit</Button>
    </li>)}</ul>
    <form onSubmit={(event) => void save(event)} className="flex flex-col gap-3" data-testid="or-project-form">
      <h2>{editing === null ? "New project" : "Edit project"}</h2>
      {field("name", "Name", true)}
      {field("repo_dir", "Repository directory (absolute path)", true)}
      {field("owner", "GitHub owner")}
      {field("repository", "GitHub repository")}
      {field("integration_branch", "Integration branch")}
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={isSaving}>{editing === null ? "Create project" : "Save project"}</Button>
      {editing !== null && <Button variant="secondary" onClick={() => { setEditing(null); setValues(EMPTY_PROJECT_FORM); }}>Cancel</Button>}
    </form>
  </main>;
}
