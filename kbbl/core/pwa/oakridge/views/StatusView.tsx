import { useInstallStatus } from "../hooks/useInstallStatus";
import type { OperatorInstallCheck, OperatorInstallStatus } from "../operator-contracts/projections/install-status-view";
import { selectAccessModeLabel, selectCheckTone } from "../state/install-status";
export function InstallCheckView({ check }: { check: OperatorInstallCheck }) {
  return <div data-tone={selectCheckTone(check)} className={selectCheckTone(check) === "danger" ? "text-[var(--tone-danger-fg)]" : "text-[var(--text-muted)]"}>
    <strong>{check.label}</strong>: {check.kind} · {check.detail}
    {check.kind !== "ok" && <p>Fix: {check.fix}</p>}
  </div>;
}
export function InstallStatusContent({ status }: { status: OperatorInstallStatus }) {
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
export function StatusView() {
  const query = useInstallStatus();
  if (query.isError) return <p role="alert">Installation status unavailable: {query.error.message}</p>;
  return query.data ? <InstallStatusContent status={query.data} /> : <p>Loading installation status…</p>;
}
