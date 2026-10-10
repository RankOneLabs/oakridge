import type { WorkflowDefinitionDescriptor as DefinitionBundle } from "./source-contracts";
import { buildBundle } from "./build-bundle";
import type { WorkflowAuthoring } from "./authoring";
import { DEVELOPMENT_POLICY, INDEPENDENT_SIBLINGS_POLICY, type RunPolicy } from "./development/policies";

export interface DevelopmentOptions { readonly independentSiblings: boolean }

/** Compose the existing Rust source contract; expansion stays outside run policy. */
export function buildDevelopmentRun(policy: RunPolicy): DefinitionBundle {
  const authoring: WorkflowAuthoring = { authoring_version: 1, template: "development", key: policy.key,
    implementation_capacity: policy.implementation_capacity, sibling_failure: policy.sibling_failure,
    wire_field_order: policy.contract_field_order, stage_layout: policy.stage_layout ?? "standard" };
  const result = buildBundle(authoring);
  if (!result.ok) throw new Error(`${result.error.field_path}: ${result.error.detail}`);
  return result.value;
}

/** Preserve the generator's established entry point. */
export function buildDevelopment(options: DevelopmentOptions): DefinitionBundle {
  return buildDevelopmentRun(options.independentSiblings ? INDEPENDENT_SIBLINGS_POLICY : DEVELOPMENT_POLICY);
}
