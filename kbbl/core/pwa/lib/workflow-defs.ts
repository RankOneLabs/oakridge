import type { WorkflowDefSummary } from "../oakridge/types";

export function sortWorkflowDefinitions(
  definitions: readonly WorkflowDefSummary[],
): WorkflowDefSummary[] {
  return [...definitions].sort((left, right) => {
    if (left.name !== right.name) return left.name.localeCompare(right.name);
    return right.version - left.version;
  });
}

export function defaultWorkflowDefinitionId(
  definitions: readonly WorkflowDefSummary[],
): string | null {
  return definitions[0]?.id ?? null;
}
