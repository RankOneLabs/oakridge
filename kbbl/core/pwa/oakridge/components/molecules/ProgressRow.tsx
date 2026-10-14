import type { OperatorRunView } from "../../operator-contracts";
import { selectRunProgress } from "../../lib/run-overview";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";

interface Props { readonly run: OperatorRunView; readonly attentionCount: number | null; readonly isAttentionLoading: boolean;
  readonly onSelectRun: (id: string) => void }
export function ProgressRow({ run, attentionCount, isAttentionLoading, onSelectRun }: Props) {
  const progress = selectRunProgress(run);
  return <Button variant="progress-row" onClick={() => onSelectRun(run.run_id)} data-testid="or-cohort-lifecycle-card">
    <span className="or-progress-row__identity"><strong>{run.run_id}</strong><small>{run.definition_digest}</small></span>
    <span className="or-progress-row__state">{progress.complete}/{progress.total} units complete</span>
    {attentionCount === null ? <span>{isAttentionLoading ? "Checking attention…" : "Attention unavailable"}</span>
      : attentionCount > 0 && <Chip tone="warning">{attentionCount} need attention</Chip>}
    <span className="or-progress-row__open">View</span>
  </Button>;
}
