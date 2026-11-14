// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorInputProvenance } from "../core-client/core-types";

export type OperatorInputProvenanceView =
  | { readonly status: "recorded"; readonly entries: readonly OperatorInputProvenance[] }
  | { readonly status: "unresolved" };
