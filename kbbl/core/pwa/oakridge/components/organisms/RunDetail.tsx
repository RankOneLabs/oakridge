import type { OperatorSchema, OperatorUnitView } from "../../operator-contracts";
import { selectDraftKey } from "../../lib/operator-selectors";
import { operatorDraftIdentity } from "../../lib/operator-drafts";
import { OperatorDecisionForm } from "./OperatorDecisionForm";
import { OperatorTypedValue } from "../molecules/OperatorTypedValue";
import { StatusBadge } from "../atoms/StatusBadge";
import { selectUnitDetailStatus, selectUnitStatusLabel } from "../../lib/run-overview";
import { OperatorHistoryPane } from "../../views/OperatorHistoryPane";

interface Props { readonly unit: OperatorUnitView; readonly schemas: readonly OperatorSchema[]; readonly onRefresh: () => void }
export function RunDetail({ unit, schemas, onRefresh }: Props) {
  return <section data-testid="or-run-detail"><header className="flex items-center gap-2">
    <h2 data-testid="or-run-detail-title">{unit.label}</h2>
    <StatusBadge subject={{ kind: "unit", status: selectUnitDetailStatus(unit) }} testId="or-run-detail-status" />
  </header>
    <h3>State</h3><p data-testid="or-run-detail-state">{selectUnitStatusLabel(unit.status)}</p>
    {unit.outcome && <><h3>Outcome</h3><OperatorTypedValue value={unit.outcome} /></>}
    {unit.attention?.kind === "waiting" && <p role="status">{unit.attention.reason}</p>}
    {unit.attention?.kind === "stalled" && <p role="alert">{unit.attention.detail}</p>}
    {unit.decisions.length > 0 && <section><h3>Available actions</h3>{unit.decisions.map((decision) =>
      <OperatorDecisionForm key={operatorDraftIdentity(selectDraftKey(unit, decision))} unit={unit} decision={decision} schemas={schemas} onRefresh={onRefresh} />)}</section>}
    <OperatorHistoryPane runId={unit.run_id} unitId={unit.unit_id} />
  </section>;
}
