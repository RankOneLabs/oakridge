import { Button } from "../../../components/atoms/Button";
import type { DelegatedSessionStageConfig } from "../../types";

const inputClass = "w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none";
const labelClass = "block text-xs font-medium text-[var(--text-muted)] mb-1";
const sectionClass = "flex flex-col gap-3 rounded-md border border-[var(--border-subtle)] p-3";

interface StageAdvancedSettingsProps {
  config: DelegatedSessionStageConfig;
  onChange: (patch: Partial<DelegatedSessionStageConfig>) => void;
  isDisabled: boolean;
}

export function StageAdvancedSettings({ config, onChange, isDisabled }: StageAdvancedSettingsProps) {
  const tools = config.pre_authorized_tools ?? [];
  const updateTool = (index: number, value: string) => onChange({ pre_authorized_tools: tools.map((tool, toolIndex) => toolIndex === index ? value : tool) });
  return <>
    <div className={sectionClass}>
      <div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase text-[var(--text-muted)]">Worktree Identity</span>
        <Button variant="secondary" size="xsmall" onClick={() => onChange({ worktree: config.worktree ? null : { branchName: "", worktreeSubdir: "", baseRef: null } })} disabled={isDisabled}>{config.worktree ? "Remove" : "+ Add"}</Button>
      </div>
      {config.worktree && <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1"><span className={labelClass}>branchName</span><input type="text" className={inputClass} value={config.worktree.branchName} onChange={(event) => onChange({ worktree: { ...config.worktree!, branchName: event.target.value } })} disabled={isDisabled} placeholder="cohort/{{UNIT_ID}}" /></label>
        <label className="flex flex-col gap-1"><span className={labelClass}>worktreeSubdir</span><input type="text" className={inputClass} value={config.worktree.worktreeSubdir} onChange={(event) => onChange({ worktree: { ...config.worktree!, worktreeSubdir: event.target.value } })} disabled={isDisabled} placeholder="wt/{{UNIT_ID}}" /></label>
        <label className="flex flex-col gap-1"><span className={labelClass}>baseRef (optional)</span><input type="text" className={inputClass} value={config.worktree.baseRef ?? ""} onChange={(event) => onChange({ worktree: { ...config.worktree!, baseRef: event.target.value || null } })} disabled={isDisabled} placeholder="main" /></label>
      </div>}
    </div>
    <div className={sectionClass}>
      <div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase text-[var(--text-muted)]">Pre-authorized Tools</span><Button variant="secondary" size="xsmall" onClick={() => onChange({ pre_authorized_tools: [...tools, ""] })} disabled={isDisabled}>+ Add</Button></div>
      {tools.length === 0 && <p className="text-xs text-[var(--text-muted)]">No pre-authorized tools.</p>}
      {tools.map((tool, index) => <div key={index} className="flex items-center gap-2"><input type="text" className={inputClass} value={tool} onChange={(event) => updateTool(index, event.target.value)} disabled={isDisabled} placeholder="Bash" aria-label={`Pre-authorized tool ${index + 1}`} /><Button variant="danger" size="xsmall" onClick={() => onChange({ pre_authorized_tools: tools.filter((_, toolIndex) => toolIndex !== index) })} disabled={isDisabled} aria-label={`Remove pre-authorized tool ${index + 1}`}>✕</Button></div>)}
    </div>
  </>;
}
