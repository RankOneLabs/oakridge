import type { OperatorInstallStatus } from "../../operator-contracts/projections/install-status-view";
import { selectAccessExplanation, selectStatusSections } from "../../lib/status-condition";
import { InstallCheckView } from "./InstallCheckView";
interface InstallStatusContentProps { readonly status: OperatorInstallStatus }
export function InstallStatusContent({ status }: InstallStatusContentProps) {
  const sections = selectStatusSections(status);
  return <article className="flex flex-col gap-4 p-3">
    <h2>Oakridge status</h2>
    {status.installation_failed ? <p role="alert">Installation failure: a required dependency failed. Fix it before launching runs.</p> : <p>All required dependencies are healthy.</p>}
    <section><h3>How operators reach Oakridge</h3><p>{selectAccessExplanation(status.access_mode)}</p></section>
    <section><h3>Required dependencies</h3>{sections.required.map((entry) => <InstallCheckView key={entry.id} entry={entry} />)}</section>
    <section><h3>Optional integrations</h3>{sections.optional.map((entry) => <InstallCheckView key={entry.id} entry={entry} />)}</section>
    <section><h3>Workflows that cannot launch</h3>{status.launch_blocks.length === 0 && <p>Every workflow can launch.</p>}{status.launch_blocks.map((block) => <div key={block.definition_id}><strong>{block.definition_name}</strong><p>{block.error.detail}</p><p>Fix: {block.error.fix}</p></div>)}</section>
  </article>;
}
