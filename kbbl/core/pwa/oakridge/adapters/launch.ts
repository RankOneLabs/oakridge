import type { OperatorDefinitionDetail, OperatorLaunchRequest } from "../operator-contracts";
import type { CreateRunRequest } from "../types";
import { selectAgentSessionTargets } from "../lib/agent-session-targets";
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

/** Maps the development input and validates session choices against the pinned definition. */
export function developmentLaunch(body: CreateRunRequest, definition: OperatorDefinitionDetail, requestId: string): AdapterResult<OperatorLaunchRequest> {
  const repositories: DevelopmentRepository[] = [];
  for (const repository of body.context.repositories) {
    const configured = body.epic_profile.repositories.find((item) => item.repository_key === repository.key);
    if (!configured) return fail("create run", `repository ${repository.key} has no forge identity`);
    repositories.push({ key: repository.key, preparation: { repository_path: repository.path, expected_head: null },
      forge: { owner: configured.forge_repository.owner, name: configured.forge_repository.name,
        build_base: body.context.base_branch, final_base: repository.integration_branch } });
  }
  const targets = selectAgentSessionTargets(definition.workflow);
  for (const target of targets) {
    const choice = body.context.session_settings[target.key];
    if (!choice?.harness || !choice.model.trim()) return fail("create run", `missing session settings for ${target.key}`);
  }
  const declaredKeys = new Set(targets.map((target) => target.key));
  for (const key of Object.keys(body.context.session_settings)) {
    if (!declaredKeys.has(key)) return fail("create run", `unknown agent worker ${key}`);
  }
  // The frozen launch form has no admission option. Its Brief approval is the
  // operator's go-ahead; the first eligible cohort starts from that outcome.
  const input: DevelopmentInput = { title: body.epic_profile.title, spec: body.context.brief_notes, repositories,
    admission: false, final_merge_policy: body.epic_profile.final_merge_policy === "guarded" ? "require_merge" : "allow_close_without_merge" };
  return ok({ request_id: requestId, digest: definition.digest, project_id: body.project_id, input,
    config: { sessions: body.context.session_settings } });
}
