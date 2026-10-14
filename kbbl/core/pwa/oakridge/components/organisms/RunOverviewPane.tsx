import type { OperatorRunView, OperatorUnitView } from "../../operator-contracts";
import { selectCompletedUnitDetails, selectRunProgress, selectWaitingUnits } from "../../lib/run-overview";
import { OperatorTypedValue } from "../molecules/OperatorTypedValue";
import { RunStageRow } from "../molecules/RunStageRows";
import { ParkedGateList } from "./ParkedGateList";

interface Props { readonly run: OperatorRunView; readonly units: readonly OperatorUnitView[]; readonly attentionCount: number; readonly onOpenUnit: (id: string) => void }
export function RunOverviewPane({ run, units, attentionCount, onOpenUnit }: Props) {
  const progress = selectRunProgress(run);
  return <section data-testid="or-run-overview"><h2>Overview</h2>
    <p>{progress.complete} of {progress.total} units complete · {attentionCount} need attention</p>
    <ul>{run.units.map((unit) => <RunStageRow key={unit.unit_id} unit={unit} onOpen={onOpenUnit} />)}</ul>
    <ParkedGateList units={units} onOpenUnit={onOpenUnit} />
    {selectWaitingUnits(units).map((unit) => <section key={unit.unit_id}>
      <h3>{unit.label}</h3><p>{unit.attention?.kind === "waiting" ? unit.attention.reason : ""}</p>
    </section>)}
    {selectCompletedUnitDetails(units).map((unit) => <section key={unit.unit_id}>
      <h3>{unit.label} outcome</h3>{unit.outcome && <OperatorTypedValue value={unit.outcome} />}
    </section>)}
  </section>;
}
