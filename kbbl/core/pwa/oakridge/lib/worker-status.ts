import { selectWorkerAttention } from "../lib/worker-attention";
import type { OperatorWorkerRecord } from "../operator-worker-types";
import type { WorkerKey, WorkerState } from "../operator-worker-types";
export interface WorkerStatusView { readonly worker: WorkerKey; readonly state: WorkerState; readonly can_retry: boolean; readonly interruption: string | null }
export const selectWorkerStatusViews = (workers: readonly OperatorWorkerRecord[]): readonly WorkerStatusView[] => workers.map((worker) => ({
  worker: worker.worker, state: worker.record.state, can_retry: selectWorkerAttention(worker).can_retry,
  interruption: worker.record.interrupted?.execution.detail ?? null,
}));
