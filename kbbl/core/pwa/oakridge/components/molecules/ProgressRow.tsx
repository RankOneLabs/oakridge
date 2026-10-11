import type { OperatorRunView } from "../../operator-contracts";
import { selectRunProgress } from "../../lib/run-overview";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";

interface Props { readonly run: OperatorRunView; readonly attentionCount: number; readonly onSelectRun: (id: string) => void }
export function ProgressRow({ run, attentionCount, onSelectRun }: Props) {
  const progress = selectRunProgress(run);
  return <Button variant="progress-row" onClick={() => onSelectRun(run.run_id)} data-testid="or-cohort-lifecycle-card">
    <span className="or-progress-row__identity"><strong>{run.run_id}</strong><small>{run.definition_digest}</small></span>
    <span className="or-progress-row__state">{progress.complete}/{progress.total} scopes complete</span>
    {attentionCount > 0 && <Chip tone="warning">{attentionCount} need attention</Chip>}
    <span className="or-progress-row__open">View</span>
  </Button>;
}
