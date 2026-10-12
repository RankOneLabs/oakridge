import type { AttemptView } from "./record-selectors";
import type { RunId, UnitId } from "../storage/schema-records";

/** An authority attempt's address in an operator run. */
export interface SessionLocation {
  readonly run_id: RunId;
  readonly unit_id: UnitId;
  readonly action_id: string;
  readonly seq: number;
}

/** An attempt is an authority attempt row; ACP process observations stay in kbbl. */
export interface RunSessionAttempt {
  readonly location: SessionLocation;
  readonly worker: string;
  readonly mode: AttemptView["mode"];
  readonly status: AttemptView["status"];
  readonly kbbl_session_id: string | null;
}

export function selectRunSessionAttempt(run_id: RunId, attempt: AttemptView): RunSessionAttempt {
  return {
    location: { run_id, unit_id: attempt.unit_id, action_id: attempt.action_id, seq: attempt.seq },
    worker: attempt.worker, mode: attempt.mode, status: attempt.status, kbbl_session_id: attempt.kbbl_session_id,
  };
}
