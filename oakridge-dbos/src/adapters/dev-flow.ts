import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import { AdapterRegistry, type AdapterDecisionContext, type AdapterDecisionHandler } from "../runtime/executor-registry";
import { BUILD_LAUNCH_REASONS, type BuildCohortTransitionEffect } from "./dev-flow-build";

interface PullRequestPayload {
  readonly repository_key: string;
  readonly pull_request_url: string;
  readonly state: string;
  readonly source: string;
  readonly merged_at: string | null;
}

const isObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodePullRequest = (value: JsonValue): Result<PullRequestPayload, string> => {
  if (!isObject(value) || typeof value.repository_key !== "string" || typeof value.pull_request_url !== "string"
    || typeof value.state !== "string" || typeof value.source !== "string"
    || !(value.merged_at === null || typeof value.merged_at === "string")) {
    return err("pull request event payload is invalid");
  }
  return ok({ repository_key: value.repository_key, pull_request_url: value.pull_request_url,
    state: value.state, source: value.source, merged_at: value.merged_at });
};

const allow = (): Result<void, string> => ok(undefined);
const effect = (context: AdapterDecisionContext, payload: PullRequestPayload) => ({
  kind: context.event_name,
  repository_key: payload.repository_key,
  pull_request_url: payload.pull_request_url,
  state: payload.state,
  source: payload.source,
  merged_at: payload.merged_at,
});

const pullRequestHandler = (name: string): AdapterDecisionHandler<PullRequestPayload> => ({
  name,
  decode: decodePullRequest,
  guard: allow,
  effect,
});

const buildTransitionHandler: AdapterDecisionHandler<BuildCohortTransitionEffect> = {
  name: "dev_flow_build_cohort_transition",
  decode(value) {
    if (!isObject(value) || value.kind !== "dev_flow_build_cohort_transition"
      || !isObject(value.event) || typeof value.event.kind !== "string"
      || typeof value.disposition !== "string" || !isObject(value.stage_data)
      || !isObject(value.projected_status)) return err("build cohort transition effect is invalid");
    return ok(value as unknown as BuildCohortTransitionEffect);
  },
  guard: allow,
  effect: (_context, payload) => payload as unknown as ReturnType<typeof effect>,
};

export const registerDevFlowAdapter = (registry: AdapterRegistry): void => {
  for (const role of ["spec", "plan", "brief", "build", "assessment", "final_integration"]) registry.register_role(role);
  for (const [role, reasons] of Object.entries(BUILD_LAUNCH_REASONS)) {
    for (const reason of reasons) registry.register_launch_reason(role, reason);
  }
  registry.register_decision(pullRequestHandler("pull_request_observed"));
  registry.register_decision(pullRequestHandler("pull_request_merge_confirmed"));
  registry.register_decision(buildTransitionHandler);
};

export const createDevFlowAdapterRegistry = (): AdapterRegistry => {
  const registry = new AdapterRegistry();
  registerDevFlowAdapter(registry);
  return registry;
};
