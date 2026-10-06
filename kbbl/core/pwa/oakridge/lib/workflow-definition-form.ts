import type { WorkflowDefInput, WorkflowDefFull } from "../types";
import type { Result } from "../../lib/result";

export interface WorkflowDefinitionValidationError {
  readonly operation: "validate_workflow_definition";
  readonly entityId: string;
  readonly details: readonly string[];
}
/** JSON is decoded at the editor boundary, then checked against the HTTP envelope; the backend validates semantics. */
export function validateWorkflowDefinition(source: string): Result<WorkflowDefInput, WorkflowDefinitionValidationError> {
  let decoded: unknown;
  try { decoded = JSON.parse(source); }
  catch (cause) { return { ok: false, error: { operation: "validate_workflow_definition", entityId: "new_workflow_definition",
    details: [cause instanceof Error ? cause.message : String(cause)] } }; }
  if (!isWorkflowDefinitionDescriptor(decoded)) return { ok: false, error: {
    operation: "validate_workflow_definition", entityId: "new_workflow_definition",
    details: ["A definition requires language version, key, positive integer version, schemas, and scopes. Semantic checks run on submission."] } };
  return { ok: true, value: decoded };
}
export function workflowDefinitionToFormState(record: WorkflowDefFull): string {
  return JSON.stringify({ ...record.definition, version: record.version + 1 }, null, 2);
}

/** The source envelope is checked here; nested schemas and trees are compiled on submission. */
function isWorkflowDefinitionDescriptor(value: unknown): value is WorkflowDefInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const definition = value as Partial<WorkflowDefInput>;
  return definition.language_version === 1 && typeof definition.key === "string" && definition.key.length > 0
    && typeof definition.version === "number" && Number.isInteger(definition.version) && definition.version > 0
    && typeof definition.root === "string" && Array.isArray(definition.schemas) && Array.isArray(definition.scopes)
    && definition.scopes.length > 0 && Array.isArray(definition.prompts) && Array.isArray(definition.operations)
    && typeof definition.limits === "object" && definition.limits !== null
    && !Object.hasOwn(definition, "stages");
}
