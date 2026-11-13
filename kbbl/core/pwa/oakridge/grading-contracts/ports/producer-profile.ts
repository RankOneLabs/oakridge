// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { ObservationJsonValue } from "../domain/primitives";

export type ObservationEvidenceCapabilityReference = string | {
  readonly capability: string;
  readonly params?: ObservationJsonValue;
};
