import type { RootWorkflowId, WorkflowRunId } from "./primitives";

/** `v2-run:<run_id>` */
export const runRecordWorkflowId = (run_id: WorkflowRunId): RootWorkflowId => `v2-run:${run_id}` as RootWorkflowId;
