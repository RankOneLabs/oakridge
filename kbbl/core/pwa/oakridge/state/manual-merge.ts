import type { OperatorRunView, OperatorRunUnitSummary } from "../operator-contracts/projections/run-view";
import type { OperatorPinnedDefinition } from "../operator-contracts/projections/definition-view";
export const MANUAL_MERGE_INDICATION = "Automatic merge observation is off for github-cli runs. Complete the merge with the Confirm merged action.";
export interface ManualMergeInput {
  readonly run: Pick<OperatorRunView, "pr_integration">;
  readonly unit: Pick<OperatorRunUnitSummary, "stage">;
  readonly definition: Pick<OperatorPinnedDefinition, "effective_workflow">;
}
export function selectManualMergeIndication({ run, unit, definition }: ManualMergeInput): boolean {
  if (run.pr_integration !== "github-cli" || unit.stage === null) return false;
  return Boolean(definition.effective_workflow.stages[unit.stage]?.reviews?.merge_confirmation?.decisions.confirm_merged);
}
