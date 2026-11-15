import type { OperatorInstallCheck } from "../../operator-contracts/projections/install-status-view";
import { selectCheckTone } from "../../state/install-status";
interface InstallCheckViewProps { readonly check: OperatorInstallCheck }
export function InstallCheckView({ check }: InstallCheckViewProps) {
  return <div data-tone={selectCheckTone(check)} className={selectCheckTone(check) === "danger" ? "text-[var(--tone-danger-fg)]" : "text-[var(--text-muted)]"}>
    <strong>{check.label}</strong>: {check.kind} · {check.detail}
    {check.kind !== "ok" && <p>Fix: {check.fix}</p>}
  </div>;
}
