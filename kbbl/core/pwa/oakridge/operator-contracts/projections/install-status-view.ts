// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorPrIntegration, OperatorPrLaunchPreflightError } from "../domain/pr-integration";

export interface OperatorInstallStatus {
  readonly access_mode: OperatorAccessMode;
  readonly checks: readonly OperatorInstallCheck[];
  readonly agent_profiles: readonly OperatorAgentProfileStatus[];
  readonly pr_integration: OperatorPrIntegrationStatus;
  readonly observation: OperatorObservationStatus;
  readonly launch_blocks: readonly OperatorLaunchBlock[];
  readonly installation_failed: boolean;
}

export type OperatorInstallCheck =
  | { readonly kind: "ok"; readonly id: string; readonly label: string; readonly required: boolean; readonly detail: string }
  | { readonly kind: "unavailable_optional"; readonly id: string; readonly label: string; readonly required: false; readonly detail: string; readonly fix: string }
  | { readonly kind: "failed"; readonly id: string; readonly label: string; readonly required: boolean; readonly detail: string; readonly fix: string };

export type OperatorAccessMode =
  | { readonly kind: "local"; readonly bind_host: string }
  | { readonly kind: "authenticated_network"; readonly bind_host: string }
  | { readonly kind: "insecure_network"; readonly bind_host: string };

export interface OperatorAgentProfileStatus {
  readonly profile_id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly readiness: OperatorInstallCheck;
}

export interface OperatorPrIntegrationStatus { readonly selected: OperatorPrIntegration; readonly health: OperatorInstallCheck }

export interface OperatorObservationStatus { readonly availability: OperatorInstallCheck }

export interface OperatorLaunchBlock {
  readonly definition_id: string;
  readonly definition_name: string;
  readonly error: OperatorPrLaunchPreflightError;
}
