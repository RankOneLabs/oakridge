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
    details: ["A definition requires a key, positive integer version, and stages object. Semantic checks run on submission."] } };
  return { ok: true, value: decoded };
}
export function workflowDefinitionToFormState(record: WorkflowDefFull): string {
  return JSON.stringify({ ...record.definition, version: record.version + 1 }, null, 2);
}

/** JSON is a decoding boundary; stage contents remain named JSON values until backend compilation. */
function isWorkflowDefinitionDescriptor(value: unknown): value is WorkflowDefInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const definition = value as Partial<WorkflowDefInput>;
  return typeof definition.key === "string" && definition.key.length > 0
    && typeof definition.version === "number" && Number.isInteger(definition.version) && definition.version > 0
    && typeof definition.stages === "object" && definition.stages !== null && !Array.isArray(definition.stages)
    && Object.keys(definition.stages).length > 0
    && Object.values(definition.stages).every(isStageDescriptor)
    && Object.keys(definition).every((key) => ["key", "version", "stages"].includes(key));
}

function isStageDescriptor(value: unknown): value is import("../workflow-definition-types").WorkflowStageDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const stage = value as Partial<import("../workflow-definition-types").WorkflowStageDescriptor>;
  return Array.isArray(stage.prerequisites) && stage.prerequisites.every((key) => typeof key === "string")
    && typeof stage.max_active_cohorts === "number" && Number.isInteger(stage.max_active_cohorts) && stage.max_active_cohorts > 0
    && typeof stage.cohort === "object" && stage.cohort !== null
    && typeof stage.cohort.workers === "object" && stage.cohort.workers !== null && !Array.isArray(stage.cohort.workers)
    && Object.hasOwn(stage.cohort, "decision_tree");
}
