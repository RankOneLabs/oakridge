import { err, ok, type Result } from "../domain/primitives";
import type { LangfuseConfig } from "./config";
import { withBoundedRetry, type LangfuseHttpClient } from "./http-client";

export type LangfuseCapability = "decision_model_evaluators" | "annotation_queues" | "score_readback" | "evaluator_api";
export interface CapabilityFailure { readonly capability: LangfuseCapability; readonly detail: string }
export interface CapabilityStatus { readonly capability: LangfuseCapability; readonly available: boolean; readonly detail: string }
export interface LangfuseFeatureReport {
  readonly openapi_path: string;
  readonly openapi_version: string;
  readonly capabilities: readonly CapabilityStatus[];
}

const paths: Readonly<Record<LangfuseCapability, string>> = {
  decision_model_evaluators: "/api/public/v2/evaluators",
  annotation_queues: "/api/public/annotation-queues",
  score_readback: "/api/public/v3/scores",
  evaluator_api: "/api/public/v2/evaluation-rules",
};

/** Inspect the deployment's own OpenAPI first; endpoint probes then verify access. */
export async function detectLangfuseFeatures(client: LangfuseHttpClient, config: LangfuseConfig):
  Promise<Result<LangfuseFeatureReport, CapabilityFailure>> {
  const openapi_path = config.base_url.includes("cloud.langfuse.com")
    ? "/generated/api/openapi.yml" : "/api/openapi.yaml";
  const spec = await withBoundedRetry(() => client.text(openapi_path, "capability_openapi"), config.retry);
  if (!spec.ok) return err({ capability: "evaluator_api", detail: `deployment OpenAPI unavailable: ${spec.error.detail}` });
  const version = /^\s*version:\s*['"]?([^\n'"]*)/m.exec(spec.value)?.[1]?.trim() ?? "unspecified";
  const capabilities: CapabilityStatus[] = [];
  for (const capability of ["decision_model_evaluators", "annotation_queues", "score_readback", "evaluator_api"] as const) {
    const path = paths[capability];
    if (!spec.value.includes(`${path}:`)) {
      capabilities.push({ capability, available: false, detail: `${path} absent from deployment OpenAPI` });
      continue;
    }
    if (capability === "decision_model_evaluators" && !config.decision_evaluator_id) {
      capabilities.push({ capability, available: false, detail: "no pinned decision-model evaluator configured" });
      continue;
    }
    const target = capability === "decision_model_evaluators"
      ? `${path}/${encodeURIComponent(config.decision_evaluator_id!)}` : `${path}?limit=1`;
    const probe = await withBoundedRetry(() => client.text(target, `capability_${capability}`), config.retry);
    capabilities.push({ capability, available: probe.ok,
      detail: probe.ok ? "available" : probe.error.detail });
  }
  return ok({ openapi_path, openapi_version: version, capabilities });
}

export function requireLangfuseCapability(report: LangfuseFeatureReport, capability: LangfuseCapability):
  Result<CapabilityStatus, CapabilityFailure> {
  const status = report.capabilities.find((item) => item.capability === capability);
  return status?.available ? ok(status) : err({ capability, detail: status?.detail ?? "capability was not probed" });
}
