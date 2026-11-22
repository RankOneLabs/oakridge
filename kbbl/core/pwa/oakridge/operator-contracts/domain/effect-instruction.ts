// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorFeedbackEntry, OperatorRevisionState } from "../core-client/core-types";

export interface OperatorPinnedPrompt { readonly path: string; readonly digest: string }

export interface OperatorEngineInputs {
  readonly previous: OperatorRevisionState | null;
  readonly feedback: readonly OperatorFeedbackEntry[];
  readonly subject: OperatorRevisionState | null;
  readonly round_delivery?: string;
  readonly self_assessment?: readonly OperatorSelfAssessmentSubject[];
}

export interface OperatorSelfAssessmentSubject {
  readonly assessment: string;
  readonly subject_artifact: string;
}
