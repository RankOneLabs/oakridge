import type { OperatorRunView, OperatorUnitView } from "../../operator-contracts";
import { selectRunArtifacts } from "../../lib/run-overview";
import { selectRunAttempts } from "../../lib/run-sessions";
import { RunSidebarArtifacts } from "../molecules/RunSidebarArtifacts";
import { RunSidebarSessions } from "../molecules/RunSidebarSessions";
import { RunStageRow } from "../molecules/RunStageRows";

interface Props {
  readonly run: OperatorRunView; readonly units: readonly OperatorUnitView[];
  readonly onOpenUnit: (id: string) => void; readonly onOpenArtifact: (id: string) => void;
}
export function RunWorkspaceSidebar({ run, units, onOpenUnit, onOpenArtifact }: Props) {
  return <aside className="or-run-workspace__sidebar" data-testid="or-run-sidebar">
    <section><h2>Units</h2><ul>{run.units.map((unit) => <RunStageRow key={unit.unit_id} unit={unit} onOpen={onOpenUnit} />)}</ul></section>
    <RunSidebarSessions attempts={selectRunAttempts(units)} onOpen={onOpenUnit} />
    <RunSidebarArtifacts artifacts={selectRunArtifacts(units)} onOpen={onOpenArtifact} />
  </aside>;
}
