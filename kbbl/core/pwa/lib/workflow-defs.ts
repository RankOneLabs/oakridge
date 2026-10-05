/** Local list descriptor for GET /workflow_defs. */
export interface WorkflowDefDescriptor {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly archived?: boolean;
}

export function sortWorkflowDefinitions(
  definitions: readonly WorkflowDefDescriptor[],
): WorkflowDefDescriptor[] {
  return [...definitions].sort((left, right) => {
    if (left.name !== right.name) return left.name.localeCompare(right.name);
    return right.version - left.version;
  });
}

export function defaultWorkflowDefinitionId(
  definitions: readonly WorkflowDefDescriptor[],
): string | null {
  return definitions[0]?.id ?? null;
}
