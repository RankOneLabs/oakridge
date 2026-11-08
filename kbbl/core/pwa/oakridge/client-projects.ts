import type { Result } from "../lib/result";
import type { Project, ProjectId, ProjectUpdateCommand, ProjectUpdateError, ProjectWriteInput } from "./project-types";
import type { OperatorProjectList, OperatorProjectView } from "./operator-contracts/http/projects";
import { parseProject, projectUpdateError, selectFailureDetail } from "./adapters/boundary";
import { API, OPERATOR, oakridgeGet, oakridgePost } from "./client-http";

const projectFromV2 = (project: OperatorProjectView): Project => ({ id: project.id as ProjectId, name: project.name,
  repo_dir: project.repo_dir, created_at: project.created_at, forge_repository: project.forge_repository,
  base_branch: project.integration_branch });

export function fetchProjects(): Promise<Project[]> {
  return oakridgeGet<OperatorProjectList>(`${OPERATOR}/projects`).then((list) => list.items.map(projectFromV2));
}

export function createProject(body: ProjectWriteInput): Promise<Project> {
  return oakridgePost<OperatorProjectView>(`${OPERATOR}/projects`, body).then(projectFromV2);
}

export async function updateProject(command: ProjectUpdateCommand): Promise<Result<Project, ProjectUpdateError>> {
  const path = `${OPERATOR}/projects/${encodeURIComponent(command.id)}`;
  try {
    const response = await fetch(`${API}${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command.project),
    });
    if (!response.ok) {
      const responseBody = await response.json().catch(() => null) as unknown;
      return projectUpdateError(path, selectFailureDetail(responseBody, `oakridge PUT ${path}: ${response.status}`));
    }
    const parsed = parseProject(await response.json());
    return parsed.ok ? parsed : projectUpdateError(path, `${parsed.error.operation}: ${parsed.error.detail}`);
  } catch (error) {
    return projectUpdateError(path, error instanceof Error ? error.message : "request failed");
  }
}
