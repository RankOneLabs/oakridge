import { MANUAL_MERGE_INDICATION, selectManualMergeIndication } from "../../state/manual-merge";
import type { OperatorRunView } from "../../operator-contracts/projections/run-view";
import type { OperatorPinnedDefinition } from "../../operator-contracts/projections/definition-view";
export interface ManualMergeBadgesProps { readonly run: OperatorRunView; readonly definition: OperatorPinnedDefinition }
export function ManualMergeBadges({ run, definition }: ManualMergeBadgesProps) {
  return <>{run.units.map((unit) => selectManualMergeIndication({ run, unit, definition }) && <p key={unit.unit_id} data-testid="manual-merge-indication" className="rounded border p-2 text-sm"><strong>{unit.label}</strong>: {MANUAL_MERGE_INDICATION}</p>)}</>;
}
