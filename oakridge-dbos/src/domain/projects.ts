import type { ProjectId } from "./primitives";

export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly repo_dir: string;
  readonly created_at: string;
  readonly forge_repository: { readonly provider: "github"; readonly owner: string; readonly name: string } | null;
  readonly base_branch: string | null;
}

export interface CreateProject {
  readonly id: ProjectId;
  readonly name: string;
  readonly repo_dir: string;
  readonly created_at: string;
  readonly forge_repository: Project["forge_repository"];
  readonly base_branch: string | null;
}

export interface ProjectRepositoryIdentity {
  readonly forge_repository: NonNullable<Project["forge_repository"]>;
  readonly base_branch: string | null;
}

export interface ProjectRepositoryIdentityResolver {
  resolve(repo_dir: string): Promise<ProjectRepositoryIdentity | null>;
}
