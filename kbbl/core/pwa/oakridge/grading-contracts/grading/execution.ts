// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { ObservationGradeObservationId } from "../domain/identity";
import type { ObservationGradeAnswer } from "./observation";

export type ObservationExecutionStatus = "queued" | "claimed" | "reclaimable" | "budget_deferred" | "completed" | "failed";

export type ObservationMeasurementState =
  | { readonly state: "not_ready"; readonly code: string; readonly detail: string }
  | { readonly state: "grading_off" }
  | { readonly state: "awaiting_admission" }
  | { readonly state: "pending"; readonly status: "queued" | "claimed" | "reclaimable" }
  | { readonly state: "budget_deferred" }
  | { readonly state: "failed"; readonly terminal_cause: ObservationExecutionTerminalCause | null; readonly error: string }
  | { readonly state: "answered"; readonly observation_id: ObservationGradeObservationId; readonly answer: ObservationGradeAnswer };

export type ObservationExecutionTerminalCause = "retry_exhausted" | "runner_failed" | "invalid_outcome";
