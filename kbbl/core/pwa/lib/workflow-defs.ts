import type { WorkflowDefSummary } from "../oakridge/project-types";

export function sortWorkflowDefinitions(
  definitions: readonly WorkflowDefSummary[],
): WorkflowDefSummary[] {
  return [...definitions].sort((left, right) => {
    if (left.name !== right.name) return left.name.localeCompare(right.name);
    return left.id.localeCompare(right.id);
  });
}

export function defaultWorkflowDefinitionId(
  definitions: readonly WorkflowDefSummary[],
): string | null {
  return definitions[0]?.id ?? null;
}
