import { runMachineWorkflowId } from "../decision/ids";
import type { RootWorkflowId, WorkflowRunId } from "./primitives";

/**
 * A run's root workflow — `v15-run:<run_id>`.
 *
 * One id, delegated to `runMachineWorkflowId`. This used to mint `v2-run:` while
 * `decision/ids` minted `v15-run:` for the same workflow, so the launch path
 * enqueued one address and the decision machines were addressed at another:
 * every launch started a workflow nothing would ever wake, and the unstarted
 * sweep kept handing the run back because the row it looked for was under the
 * name it had not used.
 */
export const runRecordWorkflowId = (run_id: WorkflowRunId): RootWorkflowId =>
  runMachineWorkflowId(run_id) as RootWorkflowId;
