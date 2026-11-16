import type { OperatorInstallStatus } from "../operator-contracts/projections/install-status-view";
export function selectLaunchBlock(status: OperatorInstallStatus | undefined, definitionId: string) {
  return status?.launch_blocks.find((block) => block.definition_id === definitionId) ?? null;
}
