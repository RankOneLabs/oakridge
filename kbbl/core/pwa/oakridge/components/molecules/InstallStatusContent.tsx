import type { OperatorInstallStatus } from "../../operator-contracts/projections/install-status-view";
import { selectAccessModeLabel } from "../../state/install-status";
import { InstallCheckView } from "./InstallCheckView";
interface InstallStatusContentProps { readonly status: OperatorInstallStatus }
export function InstallStatusContent({ status }: InstallStatusContentProps) {
  return <article className="flex flex-col gap-4 p-3">
    <h2>Installation status</h2>
    {status.installation_failed ? <p role="alert">Installation failure: a required check failed.</p> : <p>Installation checks passed.</p>}
    <section><h3>Access mode</h3><p>{selectAccessModeLabel(status.access_mode)} · {status.access_mode.bind_host}</p></section>
    <section><h3>Required checks</h3>{status.checks.map((check) => <InstallCheckView key={check.id} check={check} />)}</section>
    <section><h3>ACP agent profiles</h3>{status.agent_profiles.map((profile) => <div key={profile.profile_id}><p>{profile.label} · {profile.enabled ? "Enabled" : "Disabled"}</p><InstallCheckView check={profile.readiness} /></div>)}</section>
    <section><h3>PR integration: {status.pr_integration.selected}</h3><InstallCheckView check={status.pr_integration.health} /></section>
    <section><h3>Observation/grading</h3><InstallCheckView check={status.observation.availability} /></section>
    <section><h3>Launch blocks</h3>{status.launch_blocks.length === 0 && <p>No launch blocks.</p>}{status.launch_blocks.map((block) => <div key={block.definition_id}><strong>{block.definition_name}</strong><p>{block.error.detail}</p><p>Fix: {block.error.fix}</p></div>)}</section>
  </article>;
}
