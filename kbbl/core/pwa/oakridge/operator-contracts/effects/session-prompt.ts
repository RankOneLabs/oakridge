// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorFeedbackEntry } from "../core-client/core-types";
import type { OperatorEngineInputs } from "../domain/effect-instruction";

export interface OperatorReviewHistoryEngineInputs extends OperatorEngineInputs {
  readonly review_history?: readonly OperatorFeedbackEntry[];
}
