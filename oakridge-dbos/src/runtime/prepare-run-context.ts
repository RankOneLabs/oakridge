import type { Project } from "../domain/projects";
import type { JsonValue, Result } from "../domain/primitives";
import type { EpicWorkflowProfile, EpicWorkflowProfileId } from "../domain/epic";
import type { CreateEpicProfileRequest } from "../domain/runs";

export interface PrepareRunContextInput {
  readonly caller_context: JsonValue;
  readonly project: Project | null;
  readonly epic_profile: CreateEpicProfileRequest | null;
}

export interface PrepareRunContextError {
  readonly operation: "prepare_run_context";
  readonly detail: string;
}

export interface CreateEpicProfileInput {
  readonly id: EpicWorkflowProfileId;
  readonly workflow_run_id: EpicWorkflowProfile["workflow_run_id"];
  readonly config: CreateEpicProfileRequest;
  readonly created_at: string;
}

export const createEpicProfile = (input: CreateEpicProfileInput): EpicWorkflowProfile => ({
  id: input.id,
  workflow_run_id: input.workflow_run_id,
  title: input.config.title,
  slug: input.config.slug,
  lifecycle_state: "active",
  final_merge_policy: input.config.final_merge_policy,
  repositories: input.config.repositories.map((repository) => ({
    repository_key: repository.repository_key,
    repository_path: repository.repository_path,
    base_branch: repository.base_branch,
    epic_branch: repository.epic_branch ?? `epic/${input.config.slug}`,
    forge_repository: repository.forge_repository,
    final_pull_request: null,
    final_merge_state: "pending",
  })),
  created_at: input.created_at,
  updated_at: input.created_at,
});

const isJsonObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const prepareRunContext = (input: PrepareRunContextInput): Result<JsonValue, PrepareRunContextError> => {
  if (!input.project && !input.epic_profile) return { ok: true, value: input.caller_context };
  if (!isJsonObject(input.caller_context)) {
    return { ok: false, error: { operation: "prepare_run_context", detail: "context must be a JSON object when project or epic profile configuration is present" } };
  }

  const projectContext: Record<string, JsonValue> = input.project
    ? {
        project: { id: input.project.id, name: input.project.name, repo_dir: input.project.repo_dir },
        workdir: input.project.repo_dir,
      }
    : {};
  const callerWins = { ...projectContext, ...input.caller_context };
  if (!input.epic_profile) return { ok: true, value: callerWins };
  const epicProfile = input.epic_profile;

  return {
    ok: true,
    value: {
      ...callerWins,
      repositories: epicProfile.repositories.map((repository) => ({
        key: repository.repository_key,
        path: repository.repository_path,
        base_branch: repository.base_branch,
        epic_branch: repository.epic_branch ?? `epic/${epicProfile.slug}`,
      })),
    },
  };
};
