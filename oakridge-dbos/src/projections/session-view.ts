import type { RunId, UnitId } from "../domain/primitives";
import type { AttemptView } from "./unit-view";

/** An attempt's address in an operator run (v1 `SessionLocation`). */
export interface SessionLocation {
  readonly run_id: RunId;
  readonly unit_id: UnitId;
  readonly attempt_id: string;
}

/**
 * An attempt as the session list shows it (v1 `RunSessionAttempt`); ACP process
 * observations stay in kbbl. Part of the contract only, as in v1: no route serves it.
 */
export interface RunSessionAttempt {
  readonly location: SessionLocation;
  readonly worker_key: string;
  readonly generation: number;
  readonly status: AttemptView["status"];
  readonly result: AttemptView["result"];
}
