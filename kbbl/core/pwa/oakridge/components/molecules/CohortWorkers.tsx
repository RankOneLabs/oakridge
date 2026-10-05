import type { OperatorWorkerRecord } from "../../operator-worker-types";
import type { WorkerKey } from "../../operator-worker-types";
import { selectWorkerStatusViews } from "../../lib/worker-status";
import { Button } from "../../../components/atoms/Button";
interface CohortWorkersProps { readonly workers: readonly OperatorWorkerRecord[]; readonly onRetry: (worker: WorkerKey) => void; readonly retrying: boolean }
export function CohortWorkers({ workers, onRetry, retrying }: CohortWorkersProps) {
  return <div className="flex flex-col gap-2">{selectWorkerStatusViews(workers).map((worker) => <div key={worker.worker} className="flex flex-col gap-1">
    <span className="text-xs">{worker.worker}: {worker.state}</span>
    {worker.interruption && <span className="text-xs text-[var(--text-secondary)]">{worker.interruption}</span>}
    {worker.can_retry && <Button size="xsmall" variant="danger" disabled={retrying} onClick={() => onRetry(worker.worker)} data-testid="or-retry-unit-btn">Retry {worker.worker}</Button>}
  </div>)}</div>;
}
