import type { ExecutionView } from "./record-selectors";
import type { RunId, ScopeId } from "../storage/schema-records";

/** An authority execution's address in an operator run. */
export interface SessionLocation {
  readonly run_id: RunId;
  readonly scope_id: ScopeId;
  readonly execution_id: string;
}

/** An attempt is an authority execution; ACP process observations stay in kbbl. */
export interface RunSessionAttempt {
  readonly location: SessionLocation;
  readonly worker_key: string;
  readonly generation: number;
  readonly status: ExecutionView["status"];
  readonly result: ExecutionView["result"];
}

export function selectRunSessionAttempt(run_id: RunId, execution: ExecutionView): RunSessionAttempt {
  return { location: { run_id, scope_id: execution.scope_id, execution_id: execution.id },
    worker_key: execution.worker_key, generation: execution.generation, status: execution.status, result: execution.result };
}
