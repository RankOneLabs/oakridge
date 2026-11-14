// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorDefinitionId } from "../runtime/definition-store";

export type OperatorPrIntegration = "gated-review" | "github-cli" | "none";

export interface OperatorPrLaunchPreflightError {
  readonly kind: "integration_none" | "integration_unconfigured" | "integration_unreachable";
  readonly integration: OperatorPrIntegration;
  readonly definition_id: OperatorDefinitionId;
  readonly detail: string;
  readonly fix: string;
}
