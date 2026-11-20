import type { OperatorLaunchRequest } from "../operator-contracts/http/ingress";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import type { CreateRunRequest, StudySliceLimits, WorkflowLaunchInput } from "../launch-types";
import type { WorkflowDefSummary } from "../project-types";
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
/** Mirrors study's input in workflow-config/study.yaml: development's, plus the slice limits and an approved plan the PWA never supplies. */
interface StudyInput extends DevelopmentInput, StudySliceLimits {
  readonly approved_plan: null;
}

/** The workflows whose launch input this adapter builds. */
const PWA_LAUNCHABLE_WORKFLOWS: readonly WorkflowLaunchInput["kind"][] = ["development", "study"];

/** The launcher offers only workflows this adapter can launch. */
export const isPwaLaunchable = (definition: WorkflowDefSummary): boolean => PWA_LAUNCHABLE_WORKFLOWS.some((kind) => kind === definition.name);

/** Maps the launch input for the pinned definition's workflow and validates session choices against it. */
export function workflowLaunch(body: CreateRunRequest, definition: OperatorDefinitionDetail, requestId: string): AdapterResult<OperatorLaunchRequest> {
  if (definition.bundle.key !== body.workflow_input.kind) return fail("create run", `the ${definition.bundle.key} workflow cannot launch with ${body.workflow_input.kind} input`);
  // Both workflows prepare each repository; the first row is primary.
  if (body.context.repositories.length === 0) return fail("create run", "A run requires at least one repository");
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
  // Brief approval is the operator's go-ahead.
  const shared: DevelopmentInput = { title: body.epic_profile.title, spec: body.context.brief_notes, repositories,
    primary_repository_key: repositories[0].key,
    final_merge_policy: body.epic_profile.final_merge_policy === "guarded" ? "require_merge" : "allow_close_without_merge" };
  const input: DevelopmentInput | StudyInput = body.workflow_input.kind === "study"
    ? { ...shared, ...body.workflow_input.slice, approved_plan: null } : shared;
  return ok({ request_id: requestId, definition_id: definition.definition_id, project_id: body.project_id, input,
    config: { sessions: body.context.session_settings, grading_enabled: body.context.grading_enabled } });
}
