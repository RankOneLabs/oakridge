import type { StageDetail, StageUnit } from "../../types";
import { StatusBadge } from "../atoms/StatusBadge";

const tableCellClass = "border-b border-[var(--border-subtle)] px-3 py-2.5 align-middle";
const chipBaseClass = "inline-block rounded border bg-[var(--bg-surface)] px-2 py-0.5 text-xs font-medium";
const codeClass = "rounded bg-[var(--bg-code)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-secondary)]";
const mutedClass = "text-sm text-[var(--text-muted)]";

function stageRowClass(status: string): string {
  const base = "transition-colors hover:bg-[var(--bg-elevated)]";
  if (status === "failed") return `${base} opacity-80`;
  if (status === "parked") return `${base} border-l-2 border-l-amber-500`;
  return base;
}

interface RunStageRowProps {
  stage: StageDetail;
  canRetry: boolean;
  onRetry: (stageInstanceId: string) => void;
  retrying: boolean;
  onSelectArtifact?: (artifactId: string) => void;
}

export function RunStageRow({ stage, canRetry, onRetry, retrying, onSelectArtifact }: RunStageRowProps) {
  return (
    <tr className={stageRowClass(stage.status)} data-testid="or-stage-row">
      <td className={`${tableCellClass} font-medium text-[var(--text-primary)]`} data-testid="or-stage-name">{stage.name}</td>
      <td className={`${tableCellClass} text-[var(--text-secondary)]`}>{stage.type}</td>
      <td className={tableCellClass}><div className="flex items-center gap-2">
        <StatusBadge status={stage.status} />
        {canRetry && stage.status === "parked" && <button type="button" className="rounded border border-amber-400 px-2 py-0.5 text-xs text-amber-400 hover:bg-amber-400 hover:text-black disabled:opacity-50" onClick={() => onRetry(stage.stage_instance_id)} disabled={retrying} data-testid="or-retry-stuck-btn">{retrying ? "…" : "Retry"}</button>}
      </div></td>
      <ArtifactCell artifacts={stage.artifacts} onSelectArtifact={onSelectArtifact} />
      <SessionCell sid={stage.delegated_kbbl_sid} />
      <WorktreeCell worktree={stage.worktree} />
    </tr>
  );
}

interface RunUnitRowProps {
  stageName: string;
  stageType: string;
  unit: StageUnit;
  unitArtifacts: StageDetail["artifacts"];
  onSelectArtifact?: (artifactId: string) => void;
}

export function RunUnitRow({ stageName, stageType, unit, unitArtifacts, onSelectArtifact }: RunUnitRowProps) {
  return (
    <tr className={stageRowClass(unit.status)} data-testid="or-stage-row">
      <td className={`${tableCellClass} font-medium text-[var(--text-primary)]`} data-testid="or-stage-name">
        <span>{stageName}</span>
        {unit.repository_key && <span className="ml-1.5 rounded border border-[var(--border-muted)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]">{unit.repository_key}</span>}
        <span className="ml-1.5 rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-xs font-mono text-[var(--text-muted)]">{unit.unit_id}</span>
      </td>
      <td className={`${tableCellClass} text-[var(--text-secondary)]`}>{stageType}</td>
      <td className={tableCellClass}><div className="flex items-center gap-2">
        <StatusBadge status={unit.status} />
        {unit.gate && <span className="rounded border border-amber-400 px-1.5 py-0.5 text-xs text-amber-400">{unit.gate}</span>}
      </div></td>
      <ArtifactCell artifacts={unitArtifacts} onSelectArtifact={onSelectArtifact} />
      <SessionCell sid={unit.sid} />
      <WorktreeCell worktree={unit.worktree} />
    </tr>
  );
}

interface ArtifactCellProps {
  artifacts: StageDetail["artifacts"];
  onSelectArtifact?: (artifactId: string) => void;
}

function ArtifactCell({ artifacts, onSelectArtifact }: ArtifactCellProps) {
  return <td className={tableCellClass}>
    {artifacts.length === 0 && <span className={mutedClass}>-</span>}
    <div className="flex flex-wrap gap-1.5">{artifacts.map((artifact) => <button key={artifact.id} type="button" className={`${chipBaseClass} border-[var(--accent-blue)] text-[var(--accent-blue)] underline`} onClick={() => onSelectArtifact?.(artifact.id)}>{artifact.type_id}</button>)}</div>
  </td>;
}

function SessionCell({ sid }: { sid?: string | null }) {
  return <td className={tableCellClass} data-testid="or-stage-session">{sid ? <a href={`#sid=${encodeURIComponent(sid)}`} className="text-[var(--accent-blue)] underline" data-testid="or-delegated-session-link">{sid.slice(0, 8)}</a> : <span className={mutedClass}>-</span>}</td>;
}

function WorktreeCell({ worktree }: { worktree?: StageDetail["worktree"] }) {
  return <td className={tableCellClass} data-testid="or-stage-worktree">{worktree ? <div className="flex flex-col gap-1"><code className={codeClass} data-testid="or-stage-branch">{worktree.branch}</code><code className={codeClass} data-testid="or-stage-path">{worktree.path}</code></div> : <span className={mutedClass}>-</span>}</td>;
}
