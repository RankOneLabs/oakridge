import { parseV15WorkflowDefinition } from "../../../../../oakridge-dbos/src/validation/v15-definition";
import type { WorkflowDefInput, WorkflowDefFull } from "../types";
import type { Result } from "../../lib/result";

export interface WorkflowDefinitionValidationError {
  readonly operation: "validate_workflow_definition";
  readonly entityId: string;
  readonly details: readonly string[];
}
/** JSON is decoded at the editor boundary, then checked against the same named contract as HTTP. */
export function validateWorkflowDefinition(source: string): Result<WorkflowDefInput, WorkflowDefinitionValidationError> {
  let decoded: unknown;
  try { decoded = JSON.parse(source); }
  catch (cause) { return { ok: false, error: { operation: "validate_workflow_definition", entityId: "new_workflow_definition",
    details: [cause instanceof Error ? cause.message : String(cause)] } }; }
  const result = parseV15WorkflowDefinition(decoded);
  return result.ok ? result : { ok: false, error: { operation: "validate_workflow_definition", entityId: "new_workflow_definition",
    details: [`${result.error.path}: ${result.error.detail}`] } };
}
export function workflowDefinitionToFormState(record: WorkflowDefFull): string {
  return JSON.stringify({ ...record.definition, version: record.version + 1 }, null, 2);
}
