import type { RuntimeId } from "../../../runtime-interface";
import { defaultPlannerModelForRuntime, defaultWorkerModelForRuntime } from "../../../runtime";
import type { RuntimeDescriptor } from "../../types";
import type { RuntimeModelSelection } from "../../types";
import type { Result } from "../../lib/result";
import type { CreateRunContext, EpicProfileConfig, FinalMergePolicy, RepositoryInput } from "../types";
import type { ValidatedRepositoryInput } from "../repository-inputs";

export interface BuildRunExecutionContextInput {
  readonly brief_notes: string;
  /** The one branch this run builds on. */
  readonly base_branch: string;
  readonly repositories: RepositoryInput[];
  readonly oakridge_url: string;
  readonly planner: RuntimeModelSelection;
  readonly worker: RuntimeModelSelection;
}

export interface BuildRunExecutionContextError {
  readonly operation: "build_run_execution_context";
  readonly detail: string;
}

export function buildRunExecutionContext(input: BuildRunExecutionContextInput): Result<CreateRunContext, BuildRunExecutionContextError> {
  const worktreePath = input.repositories[0]?.path;
  if (!worktreePath) {
    return { ok: false, error: { operation: "build_run_execution_context", detail: "At least one repository with a worktree path is required." } };
  }
  return {
    ok: true,
    value: {
      brief_notes: input.brief_notes,
      base_branch: input.base_branch,
      repositories: input.repositories,
      worktree_path: worktreePath,
      oakridge_url: input.oakridge_url,
      planner_runtime: input.planner.runtime,
      planner_model: input.planner.model,
      planner_effort: input.planner.effort ?? null,
      worker_runtime: input.worker.runtime,
      worker_model: input.worker.model,
      worker_effort: input.worker.effort ?? null,
    },
  };
}

export function epicSlugFromTitle(title: string): string | null {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || null;
}

export function buildEpicProfile(title: string, finalMergePolicy: FinalMergePolicy, repositories: ValidatedRepositoryInput[]): EpicProfileConfig | null {
  const normalizedTitle = title.trim();
  const slug = epicSlugFromTitle(normalizedTitle);
  if (!normalizedTitle || !slug) return null;
  return {
    title: normalizedTitle,
    slug,
    final_merge_policy: finalMergePolicy,
    repositories: repositories.map((repository) => ({
      repository_key: repository.key,
      repository_path: repository.path,
      integration_branch: repository.integration_branch,
      forge_repository: {
        provider: "github",
        owner: repository.forge_owner,
        name: repository.forge_name,
      },
    })),
  };
}

// Shared launch-choice coercion, formerly embedded in the retired v1 spec modal.
type Role = "planner" | "worker";

function isModelAllowed(runtime: RuntimeDescriptor, model: string): boolean {
  return runtime.models.some((option) => option.value === model);
}

function getRoleDefaultModel(role: Role, runtime: RuntimeDescriptor): string {
  const preferred =
    role === "planner"
      ? defaultPlannerModelForRuntime(runtime.id)
      : defaultWorkerModelForRuntime(runtime.id);
  if (isModelAllowed(runtime, preferred)) return preferred;
  return runtime.models[0]?.value ?? preferred;
}

function getRuntimeForSelection(
  runtimeDescriptors: RuntimeDescriptor[],
  defaultRuntimeId: RuntimeId,
  runtimeId: RuntimeId,
): RuntimeDescriptor {
  return (
    runtimeDescriptors.find((runtime) => runtime.id === runtimeId) ??
    runtimeDescriptors.find((runtime) => runtime.id === defaultRuntimeId) ??
    runtimeDescriptors[0]
  );
}

export function coerceSelection(
  role: Role,
  selection: RuntimeModelSelection,
  runtimeDescriptors: RuntimeDescriptor[],
  defaultRuntimeId: RuntimeId,
  runtimeTouched: boolean,
): RuntimeModelSelection {
  const nextRuntime = runtimeTouched
    ? getRuntimeForSelection(runtimeDescriptors, defaultRuntimeId, selection.runtime)
    : getRuntimeForSelection(runtimeDescriptors, defaultRuntimeId, defaultRuntimeId);
  // Effort levels are per-runtime, so a preserved effort is only valid while
  // the runtime is unchanged AND the (possibly swapped) descriptor still
  // advertises it. The modal first renders with the pre-/config fallback
  // descriptor and later swaps to the server one, so re-validate here rather
  // than assume a same-id runtime carries the same effort set — otherwise a
  // stale level could be submitted and rejected by the backend.
  const nextEffort =
    nextRuntime.id === selection.runtime &&
    selection.effort != null &&
    nextRuntime.efforts.some((e) => e.value === selection.effort)
      ? selection.effort
      : undefined;
  if (nextRuntime.models.length === 0) {
    const nextModel = selection.model.trim().length > 0 ? selection.model : getRoleDefaultModel(role, nextRuntime);
    if (nextRuntime.id === selection.runtime && nextModel === selection.model) {
      return selection;
    }
    return {
      runtime: nextRuntime.id,
      model: nextModel,
      effort: nextEffort,
    };
  }
  const nextModel = isModelAllowed(nextRuntime, selection.model)
    ? selection.model
    : getRoleDefaultModel(role, nextRuntime);
  if (nextRuntime.id === selection.runtime && nextModel === selection.model) {
    return selection;
  }
  return {
    runtime: nextRuntime.id,
    model: nextModel,
    effort: nextEffort,
  };
}
