// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { ObservationJsonValue } from "../domain/primitives";
import type { ObservationResponseKind } from "./question";

export type ObservationGradeAnswer =
  | { readonly state: "answered"; readonly kind: "boolean"; readonly value: boolean }
  | { readonly state: "answered"; readonly kind: "choice"; readonly value: string }
  | { readonly state: "answered"; readonly kind: "ordinal"; readonly value: string }
  | { readonly state: "answered"; readonly kind: "numeric"; readonly value: number }
  | { readonly state: "answered"; readonly kind: "text"; readonly value: string }
  | { readonly state: "answered"; readonly kind: "structured"; readonly value: ObservationJsonValue }
  | { readonly state: "abstain" | "unclear"; readonly kind: ObservationResponseKind; readonly reason: string };
