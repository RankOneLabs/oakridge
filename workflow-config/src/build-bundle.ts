import { defineBundle } from "./builder";
import type { WorkflowDefinitionDescriptor } from "./source-contracts";
import type { AuthoringError, WorkflowAuthoring } from "./authoring";
import { assembleDevelopmentRun } from "./development";

export type BuildBundleResult =
  | { readonly ok: true; readonly value: WorkflowDefinitionDescriptor }
  | { readonly ok: false; readonly error: AuthoringError };

function invalid(field_path: string, detail: string): BuildBundleResult {
  return { ok: false, error: { kind: "authoring_error", field_path, detail } };
}

/** The sole producer of complete source bundles. */
export function buildBundle(authoring: WorkflowAuthoring): BuildBundleResult {
  if (authoring.authoring_version !== 1) return invalid("authoring_version", "unsupported authoring version");
  if (authoring.template !== "development") return invalid("template", "unknown workflow template");
  if (!authoring.key || !/^[a-z][a-z0-9-]*$/.test(authoring.key)) return invalid("key", "invalid workflow key");
  if (!Number.isSafeInteger(authoring.implementation_capacity) || authoring.implementation_capacity < 1)
    return invalid("implementation_capacity", "capacity must be a positive integer");
  if (authoring.sibling_failure !== "cancel" && authoring.sibling_failure !== "continue_independent")
    return invalid("sibling_failure", "unknown sibling failure policy");
  if (authoring.wire_field_order !== "canonical" && authoring.wire_field_order !== "alternate")
    return invalid("wire_field_order", "unknown field order");
  if (authoring.stage_layout !== "standard" && authoring.stage_layout !== "verification")
    return invalid("stage_layout", "unknown stage layout");
  return { ok: true, value: structuredClone(defineBundle(assembleDevelopmentRun({
    key: authoring.key,
    implementation_capacity: authoring.implementation_capacity,
    sibling_failure: authoring.sibling_failure,
    contract_field_order: authoring.wire_field_order,
    stage_layout: authoring.stage_layout,
  }))) };
}
