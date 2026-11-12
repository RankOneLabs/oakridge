// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { ObservationCompositeRelation } from "./composite";

export type ObservationAssociationProvenance =
  | { readonly kind: "own"; readonly hops: readonly ObservationAssociationHop[] }
  | { readonly kind: "relation"; readonly hops: readonly ObservationAssociationHop[] };

export type ObservationAssociationHop = Pick<ObservationCompositeRelation, "relation_id" | "type" | "evidence_ref" | "asserted_by">;
