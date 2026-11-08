// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorRunEvent } from "./run-event";

export type OperatorStreamFrameData = OperatorStreamFrame["data"] & { readonly replay: boolean };

export interface OperatorStreamInvalidation { readonly kind: "invalidate"; readonly target: "run" | "runs" | "definitions" | "projects"; readonly run_id: string | null }

export type OperatorStreamFrame =
  | { readonly event: "run_event"; readonly data: OperatorRunEvent }
  | { readonly event: "invalidate"; readonly data: OperatorStreamInvalidation };
