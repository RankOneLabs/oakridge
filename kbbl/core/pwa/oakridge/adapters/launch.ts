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
  readonly primary_repository_key: string;
  readonly final_merge_policy: "require_merge" | "allow_close_without_merge";
}

/** Previously pinned definitions still require the retired admission field. */
const requiresAdmissionInput = (definition: OperatorDefinitionDetail): boolean =>
  definition.workflow.input !== null && typeof definition.workflow.input === "object"
    && Object.hasOwn(definition.workflow.input, "admission");

/** Maps the development input and validates session choices against the pinned definition. */
export function developmentLaunch(body: CreateRunRequest, definition: OperatorDefinitionDetail, requestId: string): AdapterResult<OperatorLaunchRequest> {
  if (body.context.repositories.length !== 1) return fail("create run", "Development runs require exactly one repository");
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
    const stage = Object.hasOwn(body.context.session_settings, target.stage) ? body.context.session_settings[target.stage] : undefined;
    const choice = stage && Object.hasOwn(stage, target.worker) ? stage[target.worker] : undefined;
    if (!choice?.harness || !choice.model.trim()) return fail("create run", `missing session settings for ${target.label}`);
  }
  const declaredKeys = new Set(targets.map((target) => target.key));
  for (const [stage, workers] of Object.entries(body.context.session_settings)) {
    if (Object.keys(workers).length === 0) return fail("create run", `unknown agent stage ${stage}`);
    for (const worker of Object.keys(workers)) {
      if (!declaredKeys.has(JSON.stringify([stage, worker]))) return fail("create run", `unknown agent worker ${stage} · ${worker}`);
    }
  }
  // Brief approval is the operator's go-ahead for new definitions. Older
  // pinned definitions still require admission=false in their launch input.
  const input: DevelopmentInput = { title: body.epic_profile.title, spec: body.context.brief_notes, repositories,
    primary_repository_key: repositories[0].key,
    final_merge_policy: body.epic_profile.final_merge_policy === "guarded" ? "require_merge" : "allow_close_without_merge" };
  const launchInput = requiresAdmissionInput(definition) ? { ...input, admission: false } : input;
  return ok({ request_id: requestId, digest: definition.digest, project_id: body.project_id, input: launchInput,
    config: { sessions: body.context.session_settings } });
}
