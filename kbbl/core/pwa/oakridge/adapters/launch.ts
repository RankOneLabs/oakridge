import type { OperatorDefinitionSummary, OperatorLaunchRequest } from "../operator-contracts";
import type { CreateRunRequest } from "../types";
import { fail, ok, type AdapterResult } from "./core";

interface DevelopmentRepository {
  readonly key: string;
  readonly preparation: { readonly repository_path: string; readonly expected_head: null };
  readonly forge: { readonly owner: string; readonly name: string; readonly build_base: string; readonly final_base: string };
}
interface DevelopmentInput {
  readonly title: string;
  readonly spec: string;
  readonly repositories: readonly DevelopmentRepository[];
  readonly admission: boolean;
  readonly final_merge_policy: "require_merge" | "allow_close_without_merge";
}

/** Mirrors the development workflow's declared input and six stage keys. */
export function developmentLaunch(body: CreateRunRequest, definition: OperatorDefinitionSummary, requestId: string): AdapterResult<OperatorLaunchRequest> {
  const repositories: DevelopmentRepository[] = [];
  for (const repository of body.context.repositories) {
    const configured = body.epic_profile.repositories.find((item) => item.repository_key === repository.key);
    if (!configured) return fail("create run", `repository ${repository.key} has no forge identity`);
    repositories.push({ key: repository.key, preparation: { repository_path: repository.path, expected_head: null },
      forge: { owner: configured.forge_repository.owner, name: configured.forge_repository.name,
        build_base: body.context.base_branch, final_base: repository.integration_branch } });
  }
  const planner = { harness: body.context.planner_runtime, model: body.context.planner_model, effort: body.context.planner_effort };
  const worker = { harness: body.context.worker_runtime, model: body.context.worker_model, effort: body.context.worker_effort };
  const input: DevelopmentInput = { title: body.epic_profile.title, spec: body.context.brief_notes, repositories,
    admission: true, final_merge_policy: body.epic_profile.final_merge_policy === "guarded" ? "require_merge" : "allow_close_without_merge" };
  return ok({ request_id: requestId, digest: definition.digest, project_id: body.project_id, input,
    config: { sessions: { prepare: worker, analysis: planner, planning: planner, brief: planner, cohort: worker, integration: worker } } });
}
