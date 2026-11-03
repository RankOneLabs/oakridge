import { useState, type Dispatch, type SetStateAction } from "react";

import type { Project, RepositoryInputDraft } from "../../types";
import { repositoryDraftFromProject } from "../../repository-inputs";
import { Button } from "../../../components/atoms/Button";

interface RepositoryLaunchFieldsProps {
  repositories: RepositoryInputDraft[];
  setRepositories: Dispatch<SetStateAction<RepositoryInputDraft[]>>;
  projects: Project[];
  isLoadingProjects: boolean;
  disabled: boolean;
}

const inputClass = "or-form-input";

export function RepositoryLaunchFields({ repositories, setRepositories, projects, isLoadingProjects, disabled }: RepositoryLaunchFieldsProps) {
  const [isChoosingProject, setIsChoosingProject] = useState(false);
  const update = (index: number, patch: Partial<RepositoryInputDraft>) => {
    setRepositories((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  };
  const addFromProject = (projectId: string) => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) return;
    setRepositories((current) => [...current, repositoryDraftFromProject(project, {
      key: "", path: "", forge_owner: "", forge_name: "", integration_branch: "main",
    })]);
    setIsChoosingProject(false);
  };

  return (
    <fieldset className="or-repository-launch">
      <legend className="or-repository-launch__legend">
        <span className="or-repository-launch__heading">
          <span>Repositories</span>
          <Button variant="secondary" disabled={disabled || isLoadingProjects} onClick={() => setIsChoosingProject(true)}>+ Repository</Button>
        </span>
      </legend>
      {isChoosingProject && (
        <div className="flex items-center gap-3">
          <select
            className={inputClass}
            value=""
            onChange={(event) => addFromProject(event.target.value)}
            disabled={disabled || isLoadingProjects || projects.length === 0}
            aria-label="Project for additional repository"
            autoFocus
          >
            <option value="">{projects.length === 0 ? "No projects available" : "Choose a project…"}</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <Button variant="secondary" disabled={disabled} onClick={() => setIsChoosingProject(false)}>Cancel</Button>
        </div>
      )}
      {repositories.map((repository, index) => (
        <div className="or-repository-fields" key={index}>
          <input type="text" className={inputClass} value={repository.key} onChange={(event) => update(index, { key: event.target.value })} disabled={disabled} placeholder="Key (api)" aria-label={`Repository ${index + 1} key`} required />
          <input type="text" className={inputClass} value={repository.forge_owner} onChange={(event) => update(index, { forge_owner: event.target.value })} disabled={disabled} placeholder="GitHub owner" aria-label={`Repository ${index + 1} GitHub owner`} required />
          <input type="text" className={inputClass} value={repository.forge_name} onChange={(event) => update(index, { forge_name: event.target.value })} disabled={disabled} placeholder="GitHub repository" aria-label={`Repository ${index + 1} GitHub name`} required />
          <input type="text" className={inputClass} value={repository.integration_branch} onChange={(event) => update(index, { integration_branch: event.target.value })} disabled={disabled} placeholder="Integration branch (main)" aria-label={`Repository ${index + 1} integration branch`} required />
          <input type="text" className={inputClass} value={repository.path} onChange={(event) => update(index, { path: event.target.value })} disabled={disabled} placeholder="/absolute/path/to/repo" aria-label={`Repository ${index + 1} path`} required />
          <Button variant="secondary" className="w-full md:w-auto" disabled={disabled || repositories.length === 1} onClick={() => setRepositories((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove repository ${index + 1}`}>Remove</Button>
        </div>
      ))}
    </fieldset>
  );
}
