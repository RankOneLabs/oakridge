import type { OperatorWorkerRecord } from "../operator-worker-types";
export interface WorkerAttention { readonly can_retry: boolean; readonly needs_review: boolean; readonly needs_attention: boolean }
export const selectWorkerAttention = (worker: OperatorWorkerRecord): WorkerAttention => {
  const can_retry = worker.record.state === "interrupted";
  const needs_review = worker.record.state === "awaiting_review";
  return { can_retry, needs_review, needs_attention: can_retry || needs_review };
};
