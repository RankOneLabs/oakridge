import type { OperatorInstallStatus, OperatorInstallCheck } from "../operator-contracts/projections/install-status-view";
import { fail, ok, type AdapterResult } from "./core";
interface Fields { readonly [key: string]: unknown }
const fields = (raw: unknown): raw is Fields => typeof raw === "object" && raw !== null && !Array.isArray(raw);
const integration = (raw: unknown) => raw === "none" || raw === "gated-review" || raw === "github-cli";
function check(raw: unknown): raw is OperatorInstallCheck {
  if (!fields(raw) || typeof raw.id !== "string" || typeof raw.label !== "string" || typeof raw.detail !== "string" || typeof raw.required !== "boolean") return false;
  return raw.kind === "ok" || (typeof raw.fix === "string" && (raw.kind === "failed" || raw.kind === "unavailable_optional" && raw.required === false));
}
/** Validate shape only; all verdicts remain DBOS-owned. */
export function parseInstallStatus(raw: unknown): AdapterResult<OperatorInstallStatus> {
  const invalid = () => fail("install_status", "malformed installation status");
  if (!fields(raw) || !fields(raw.access_mode) || typeof raw.access_mode.bind_host !== "string" || !["local", "authenticated_network", "insecure_network"].includes(String(raw.access_mode.kind))) return invalid();
  if (typeof raw.installation_failed !== "boolean" || !Array.isArray(raw.checks) || !raw.checks.every(check) || !Array.isArray(raw.agent_profiles) || !raw.agent_profiles.every((profile: unknown) => fields(profile) && typeof profile.profile_id === "string" && typeof profile.label === "string" && typeof profile.enabled === "boolean" && check(profile.readiness))) return invalid();
  if (!fields(raw.pr_integration) || !integration(raw.pr_integration.selected) || !check(raw.pr_integration.health) || !fields(raw.observation) || !check(raw.observation.availability)) return invalid();
  if (!Array.isArray(raw.launch_blocks) || !raw.launch_blocks.every((block: unknown) => fields(block) && typeof block.definition_id === "string" && typeof block.definition_name === "string" && fields(block.error) && typeof block.error.detail === "string" && typeof block.error.fix === "string" && typeof block.error.definition_id === "string" && integration(block.error.integration) && ["integration_none", "integration_unconfigured", "integration_unreachable"].includes(String(block.error.kind)))) return invalid();
  return ok(raw as unknown as OperatorInstallStatus);
}
