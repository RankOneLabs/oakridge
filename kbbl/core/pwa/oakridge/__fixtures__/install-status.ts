import type { OperatorInstallStatus } from "../operator-contracts/projections/install-status-view";
export const installStatus: OperatorInstallStatus = {
  access_mode: { kind: "local", bind_host: "127.0.0.1" },
  checks: [{ kind: "ok", id: "dbos", label: "DBOS", required: true, detail: "Ready" }],
  agent_profiles: [], pr_integration: { selected: "none", health: { kind: "unavailable_optional", id: "pr", label: "PR integration", required: false, detail: "No gateway selected", fix: "Select a PR integration" } },
  observation: { availability: { kind: "unavailable_optional", id: "observation", label: "Observation", required: false, detail: "Observation disabled", fix: "Start with --observation" } },
  launch_blocks: [], installation_failed: false,
};
