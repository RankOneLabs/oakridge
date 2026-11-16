import type { OperatorInstallStatus, OperatorInstallCheck, OperatorAgentProfileStatus, OperatorPrIntegrationStatus } from "../operator-contracts/projections/install-status-view";
export type StatusSource = { kind: "check"; check: OperatorInstallCheck } | { kind: "agent_profile"; profile: OperatorAgentProfileStatus } | { kind: "pr_integration"; status: OperatorPrIntegrationStatus } | { kind: "observation"; check: OperatorInstallCheck };
export type StatusCondition = { kind: "healthy" } | { kind: "disabled"; reason: "profile_disabled" | "integration_none" } | { kind: "unavailable"; fix: string } | { kind: "failed"; fix: string };
export interface StatusEntry { readonly id: string; readonly label: string; readonly detail: string; readonly required: boolean; readonly condition: StatusCondition }
export interface StatusSections { readonly required: StatusEntry[]; readonly optional: StatusEntry[] }
export function selectStatusCondition(source: StatusSource): StatusCondition {
  if (source.kind === "agent_profile" && !source.profile.enabled) return { kind: "disabled", reason: "profile_disabled" };
  if (source.kind === "pr_integration" && source.status.selected === "none") return { kind: "disabled", reason: "integration_none" };
  const check = source.kind === "agent_profile" ? source.profile.readiness : source.kind === "pr_integration" ? source.status.health : source.check;
  switch (check.kind) {
    case "ok": return { kind: "healthy" };
    case "failed": return { kind: "failed", fix: check.fix };
    case "unavailable_optional": return { kind: "unavailable", fix: check.fix };
  }
}
function selectStatusEntry(source: StatusSource): StatusEntry {
  const check = source.kind === "agent_profile" ? source.profile.readiness : source.kind === "pr_integration" ? source.status.health : source.check;
  const label = source.kind === "agent_profile" ? source.profile.label : source.kind === "pr_integration" ? `PR integration: ${source.status.selected}` : check.label;
  return { id: source.kind === "agent_profile" ? source.profile.profile_id : check.id, label, detail: check.detail, required: check.required, condition: selectStatusCondition(source) };
}
export function selectStatusSections(status: OperatorInstallStatus): StatusSections {
  const entries: StatusEntry[] = [
    ...status.checks.map((check) => selectStatusEntry({ kind: "check", check })),
    ...status.agent_profiles.map((profile) => selectStatusEntry({ kind: "agent_profile", profile })),
    selectStatusEntry({ kind: "pr_integration", status: status.pr_integration }),
    selectStatusEntry({ kind: "observation", check: status.observation.availability }),
  ];
  return { required: entries.filter((entry) => entry.required), optional: entries.filter((entry) => !entry.required) };
}
export function selectAccessExplanation(mode: OperatorInstallStatus["access_mode"]): string {
  switch (mode.kind) {
    case "local": return `Local access: Oakridge listens only on the loopback address ${mode.bind_host}, so only this machine can reach it.`;
    case "authenticated_network": return `Authenticated network access: Oakridge listens on ${mode.bind_host}, which other machines on the network can reach, and every operator request must present the control token (OAKRIDGE_CONTROL_TOKEN).`;
    case "insecure_network": return `Insecure network access: Oakridge listens on ${mode.bind_host} and accepts operator requests from the network without a control token (ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1).`;
  }
}
