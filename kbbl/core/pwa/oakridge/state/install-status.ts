import type { OperatorAccessMode, OperatorInstallCheck, OperatorInstallStatus } from "../operator-contracts/projections/install-status-view";
export function selectAccessModeLabel(mode: OperatorAccessMode): string {
  switch (mode.kind) {
    case "local": return "Local";
    case "authenticated_network": return "Authenticated network";
    case "insecure_network": return "Insecure network";
  }
}
export function selectCheckTone(check: OperatorInstallCheck): "danger" | "muted" | "success" {
  return check.kind === "ok" ? "success" : check.kind === "failed" && check.required ? "danger" : "muted";
}
export function selectLaunchBlock(status: OperatorInstallStatus | undefined, definitionId: string) {
  return status?.launch_blocks.find((block) => block.definition_id === definitionId) ?? null;
}
