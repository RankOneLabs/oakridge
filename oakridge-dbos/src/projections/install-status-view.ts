import { isLoopbackHost } from "../http/control-auth";
import type { PrIntegration, PrLaunchPreflightError } from "../domain/pr-integration";
import type { DefinitionId } from "../runtime/definition-store";

export type InstallCheck =
  | { readonly kind: "ok"; readonly id: string; readonly label: string; readonly required: boolean; readonly detail: string }
  | { readonly kind: "unavailable_optional"; readonly id: string; readonly label: string; readonly required: false; readonly detail: string; readonly fix: string }
  | { readonly kind: "failed"; readonly id: string; readonly label: string; readonly required: boolean; readonly detail: string; readonly fix: string };
export type AccessMode =
  | { readonly kind: "local"; readonly bind_host: string }
  | { readonly kind: "authenticated_network"; readonly bind_host: string }
  | { readonly kind: "insecure_network"; readonly bind_host: string };
export interface AgentProfileStatus {
  readonly profile_id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly readiness: InstallCheck;
}
export interface PrIntegrationStatus { readonly selected: PrIntegration; readonly health: InstallCheck }
export interface ObservationStatus { readonly availability: InstallCheck }
export interface LaunchBlock {
  readonly definition_id: DefinitionId;
  readonly definition_name: string;
  readonly error: PrLaunchPreflightError;
}
export interface InstallStatus {
  readonly access_mode: AccessMode;
  readonly checks: readonly InstallCheck[];
  readonly agent_profiles: readonly AgentProfileStatus[];
  readonly pr_integration: PrIntegrationStatus;
  readonly observation: ObservationStatus;
  readonly launch_blocks: readonly LaunchBlock[];
  readonly installation_failed: boolean;
}
export interface AccessModeInput {
  readonly bind_host: string;
  readonly has_control_token: boolean;
  readonly allow_insecure_non_loopback: boolean;
}
export function selectAccessMode(input: AccessModeInput): AccessMode | Extract<InstallCheck, { kind: "failed" }> {
  const { bind_host } = input;
  if (isLoopbackHost(bind_host)) return { kind: "local", bind_host };
  if (input.has_control_token) return { kind: "authenticated_network", bind_host };
  if (input.allow_insecure_non_loopback) return { kind: "insecure_network", bind_host };
  return { kind: "failed", id: "access_mode", label: "Operator access", required: true,
    detail: `Non-loopback bind ${bind_host} requires explicit operator access configuration`,
    fix: "Set OAKRIDGE_CONTROL_TOKEN, bind to 127.0.0.1, or set ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1" };
}
export function selectInstallationFailed(checks: readonly InstallCheck[]): boolean {
  return checks.some((check) => check.kind === "failed" && check.required);
}
export type InstallStatusSources = Omit<InstallStatus, "installation_failed">;
export function assembleInstallStatus(sources: InstallStatusSources): InstallStatus {
  return { ...sources, installation_failed: selectInstallationFailed([
    ...sources.checks, ...sources.agent_profiles.map((profile) => profile.readiness),
    sources.pr_integration.health, sources.observation.availability,
  ]) };
}
