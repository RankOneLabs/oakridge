import { selectWorkerAttention } from "../../../../../oakridge-dbos/src/domain/worker-attention";
import type { OperatorWorkerRecord } from "../../../../../oakridge-dbos/src/domain/operator-projections";
import type { V15WorkerKey, WorkerState } from "../../../../../oakridge-dbos/src/domain/dev-flow-v15";
export interface WorkerStatusView { readonly worker: V15WorkerKey; readonly state: WorkerState; readonly can_retry: boolean; readonly interruption: string | null }
export const selectWorkerStatusViews = (workers: readonly OperatorWorkerRecord[]): readonly WorkerStatusView[] => workers.map((worker) => ({
  worker: worker.worker, state: worker.record.state, can_retry: selectWorkerAttention(worker).can_retry,
  interruption: worker.record.interrupted?.execution.detail ?? null,
}));
