// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorAssessmentStatus } from "../core-client/core-types";

export interface OperatorAssessmentRead extends OperatorAssessmentStatus {
  readonly item_sources: readonly OperatorAssessmentItemSource[];
}

export interface OperatorAssessmentItemSource {
  readonly item: string;
  readonly proposal_key: string | null;
  readonly instruction: string;
}
