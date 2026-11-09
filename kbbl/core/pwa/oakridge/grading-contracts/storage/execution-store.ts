// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { ObservationRunId } from "../domain/identity";
import type { ObservationExecutionStatus } from "../grading/execution";
import type { ObservationRunConfigWire } from "../ingest/cursor";

export interface ObservationRunSpend {
  readonly run_id: ObservationRunId;
  /** The choice the run's captured launch committed. */
  readonly is_grading_enabled: boolean;
  /** The exact config the launch delivered, or null when it carried none. */
  readonly captured_config: ObservationRunConfigWire | null;
  readonly committed: number;
  readonly requests_sent: number;
  readonly attempts: number;
  readonly executions: Readonly<Record<ObservationExecutionStatus, number>>;
}

export interface ObservationAttemptRead {
  readonly attempt: number;
  readonly request_sent: boolean;
  readonly outcome: "completed" | "failed" | null;
  readonly failure_category: string | null;
  readonly charged_cost: number;
  readonly admitted_estimate: number;
  readonly provider_request_id: string | null;
}
