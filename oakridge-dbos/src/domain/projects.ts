import type { ProjectId } from "./primitives";

/**
 * A configured repository checkout.
 *
 * `integration_branch` is the discovered default branch — where this
 * repository's finished work merges back. It was called `base_branch`, which in
 * v14 meant two different branches depending on who was asking
 * (`domain/repository-refs.ts` records the whole tangle); v15's `oakridge.project`
 * column is `integration_branch`, and this is the name that matches it.
 */
export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly repo_dir: string;
  readonly created_at: string;
  readonly forge_repository: { readonly provider: "github"; readonly owner: string; readonly name: string } | null;
  readonly integration_branch: string | null;
}

export interface CreateProject {
  readonly id: ProjectId;
  readonly name: string;
  readonly repo_dir: string;
  readonly created_at: string;
  readonly forge_repository: Project["forge_repository"];
  readonly integration_branch: string | null;
}

export interface UpdateProject {
  readonly name: string;
  readonly repo_dir: string;
  readonly forge_repository: Project["forge_repository"];
  readonly integration_branch: string | null;
}

export interface ProjectRepositoryIdentity {
  readonly forge_repository: NonNullable<Project["forge_repository"]>;
  readonly integration_branch: string | null;
}

export interface ProjectRepositoryIdentityResolver {
  resolve(repo_dir: string): Promise<ProjectRepositoryIdentity | null>;
}
