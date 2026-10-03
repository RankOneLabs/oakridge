import type { OperatorWorkerRecord } from "../../../../../oakridge-dbos/src/domain/operator-projections";
import type { V15WorkerKey, WorkerState } from "../../../../../oakridge-dbos/src/domain/dev-flow-v15";
export interface WorkerStatusView { readonly worker: V15WorkerKey; readonly state: WorkerState; readonly can_retry: boolean; readonly interruption: string | null }
export const selectWorkerStatusViews = (workers: readonly OperatorWorkerRecord[]): readonly WorkerStatusView[] => workers.map(({ worker, record }) => ({
  worker, state: record.state, can_retry: record.state === "interrupted", interruption: record.interrupted?.execution.detail ?? null,
}));
