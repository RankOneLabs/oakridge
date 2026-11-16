import type { StatusEntry } from "../../lib/status-condition";
import { selectConditionTone } from "../../lib/status-tone";
import { Chip } from "../../../components/atoms/Chip";
interface InstallCheckViewProps { readonly entry: StatusEntry }
const labels = { healthy: "Healthy", disabled: "Disabled", unavailable: "Unavailable", failed: "Failed" } as const;
export function InstallCheckView({ entry }: InstallCheckViewProps) {
  const condition = entry.condition;
  return <div data-tone={selectConditionTone(condition)}>
    <strong>{entry.label}</strong> <Chip tone={selectConditionTone(condition)}>{labels[condition.kind]}</Chip><p>{entry.detail}</p>
    {condition.kind === "disabled" && <p>{condition.reason === "profile_disabled" ? "Disabled: this agent profile is turned off." : "Disabled: no PR integration is selected."}</p>}
    {(condition.kind === "failed" || condition.kind === "unavailable") && <p>Fix: {condition.fix}</p>}
  </div>;
}
