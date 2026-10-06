import { decodeDefinitionBundle } from "../workflow-definition-types";
import type { WorkflowDefInput, WorkflowDefFull } from "../types";
import type { Result } from "../../lib/result";

export interface WorkflowDefinitionValidationError {
  readonly operation: "validate_workflow_definition";
  readonly entityId: string;
  readonly details: readonly string[];
}
/** Decode the full source shape at the editor boundary; the backend compiles its semantics. */
export function validateWorkflowDefinition(source: string): Result<WorkflowDefInput, WorkflowDefinitionValidationError> {
  let decoded: unknown;
  try { decoded = JSON.parse(source); }
  catch (cause) { return { ok: false, error: { operation: "validate_workflow_definition", entityId: "new_workflow_definition",
    details: [cause instanceof Error ? cause.message : String(cause)] } }; }
  const definition = decodeDefinitionBundle(decoded);
  if (!definition || definition.language_version !== 1 || !definition.key || !Number.isSafeInteger(definition.version) || definition.version <= 0 || !definition.root || definition.scopes.length === 0) return { ok: false, error: {
    operation: "validate_workflow_definition", entityId: "new_workflow_definition",
    details: ["A definition must match the generic source schema, with language version 1, a key, a positive integer version, and a root scope. Semantic checks run on submission."] } };
  return { ok: true, value: definition };
}
export function workflowDefinitionToFormState(record: WorkflowDefFull): string {
  return JSON.stringify({ ...record.definition, version: record.version + 1 }, null, 2);
}
