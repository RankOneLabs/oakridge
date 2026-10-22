import type { ForgeRepository } from "../storage/json-column-types";
import type { ProjectId } from "./primitives";

/**
 * A project is a saved repository checkout an operator launches runs against;
 * its row is `authority.project` (storage/schema-records.ts `ProjectRecord`).
 * `integration_branch` is the default branch where finished work merges back.
 */
/** What an operator supplies to create or replace a project. */
export interface ProjectDraft {
  readonly name: string;
  readonly repo_dir: string;
  readonly forge_repository: ForgeRepository | null;
  readonly integration_branch: string | null;
}
/** Fields supplied by the project form; omitted repository details are read from Git. */
export interface ProjectWriteInput {
  readonly name: string;
  readonly repo_dir: string;
  readonly forge_repository?: ForgeRepository | null;
  readonly integration_branch?: string | null;
}
export interface ProjectRepositoryIdentity {
  readonly forge_repository: ForgeRepository;
  readonly integration_branch: string | null;
}
export type ProjectWriteError =
  | { readonly kind: "duplicate_name"; readonly name: string }
  | { readonly kind: "missing"; readonly id: ProjectId };

