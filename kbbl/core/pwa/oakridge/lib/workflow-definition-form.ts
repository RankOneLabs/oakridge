import type { Result } from "../../lib/result";
import type { OperatorDefinitionSummary, OperatorWorkflow } from "../operator-contracts";
import { decodeWorkflowSource } from "../workflow-definition-types";

/** The editor's text as a workflow source: JSON in the core's workflow shape, which the authority then compiles. */
export function parseWorkflowText(text: string): Result<OperatorWorkflow, string> {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return { ok: false, error: "Enter the workflow as valid JSON." }; }
  const workflow = decodeWorkflowSource(value);
  return workflow ? { ok: true, value: workflow } : { ok: false, error: "This is not a workflow: it needs workflow, input, run and stages." };
}

export const formatWorkflowText = (workflow: OperatorWorkflow): string => JSON.stringify(workflow, null, 2);

/** A clone is renamed, so pinning it leaves its source's definition as it is. */
export const selectCloneWorkflow = (workflow: OperatorWorkflow): OperatorWorkflow => ({ ...workflow, workflow: `${workflow.workflow}_copy` });

export function selectDefinitionSummary(active: readonly OperatorDefinitionSummary[] | undefined,
  archived: readonly OperatorDefinitionSummary[] | undefined, bundleId: string): OperatorDefinitionSummary | null {
  return active?.find((item) => item.bundle_id === bundleId)
    ?? archived?.find((item) => item.bundle_id === bundleId) ?? null;
}
