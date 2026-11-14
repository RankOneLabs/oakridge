import type { DefinitionId } from "../runtime/definition-store";

export const PR_INTEGRATIONS = ["gated-review", "github-cli", "none"] as const;
export type PrIntegration = "gated-review" | "github-cli" | "none";
export function parsePrIntegration(value: unknown): PrIntegration | null {
  return PR_INTEGRATIONS.find((integration) => integration === value) ?? null;
}
export interface PrLaunchPreflightError {
  readonly kind: "integration_none" | "integration_unconfigured" | "integration_unreachable";
  readonly integration: PrIntegration;
  readonly definition_id: DefinitionId;
  readonly detail: string;
  readonly fix: string;
}
