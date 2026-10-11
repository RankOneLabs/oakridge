import type { WorkflowAuthoring } from "../../../../../workflow-config/src/authoring";
import type { OperatorDefinitionSummary } from "../operator-contracts";

export const EMPTY_AUTHORING: WorkflowAuthoring = {
  authoring_version: 1,
  template: "development",
  key: "development",
  implementation_capacity: 2,
  sibling_failure: "cancel",
  wire_field_order: "canonical",
  stage_layout: "standard",
};

/** The detail endpoint carries the exact authoring choices used to build a bundle. */
export function selectStoredAuthoring(detail: unknown): WorkflowAuthoring | null {
  if (typeof detail !== "object" || detail === null || !("authoring" in detail)) return null;
  const value = detail.authoring;
  if (typeof value !== "object" || value === null) return null;
  if (!("authoring_version" in value) || value.authoring_version !== 1
    || !("template" in value) || value.template !== "development"
    || !("key" in value) || typeof value.key !== "string"
    || !("implementation_capacity" in value) || typeof value.implementation_capacity !== "number"
    || !("sibling_failure" in value) || (value.sibling_failure !== "cancel" && value.sibling_failure !== "continue_independent")
    || !("wire_field_order" in value) || (value.wire_field_order !== "canonical" && value.wire_field_order !== "alternate")
    || !("stage_layout" in value) || (value.stage_layout !== "standard" && value.stage_layout !== "verification")) return null;
  return value as WorkflowAuthoring;
}

export function selectCloneAuthoring(authoring: WorkflowAuthoring): WorkflowAuthoring {
  return { ...authoring, key: `${authoring.key}-copy` };
}

export function selectDefinitionSummary(active: readonly OperatorDefinitionSummary[] | undefined,
  archived: readonly OperatorDefinitionSummary[] | undefined, bundleId: string): OperatorDefinitionSummary | null {
  return active?.find((item) => item.bundle_id === bundleId)
    ?? archived?.find((item) => item.bundle_id === bundleId) ?? null;
}
