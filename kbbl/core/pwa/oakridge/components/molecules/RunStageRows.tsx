import { CohortWorkers } from "./CohortWorkers";
import type { V15WorkerKey } from "../../../../../../oakridge-dbos/src/domain/dev-flow-v15";
import type { StageDetail, StageUnit } from "../../types";
import { StatusBadge } from "../atoms/StatusBadge";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import { selectCohortBrief } from "../../lib/stage-unit-params";

const tableCellClass = "border-b border-[var(--border-subtle)] px-3 py-2.5 align-middle";
const codeClass = "rounded bg-[var(--bg-code)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-secondary)]";
const mutedClass = "text-sm text-[var(--text-muted)]";

function stageRowClass(status: string): string {
  const base = "transition-colors hover:bg-[var(--bg-elevated)]";
  if (status === "failed") return `${base} opacity-80`;
  if (status === "blocked") return `${base} border-l-2 border-l-amber-500`;
  return base;
}

interface RunStageRowProps {
  stage: StageDetail;
  unitState?: string;
  workers: StageUnit["workers"];
  onRetryWorker: (worker: V15WorkerKey) => void;
  onSelectArtifact?: (artifactId: string) => void;
  abandon?: AbandonAction;
  retry?: {
    readonly onRetry: () => void;
    readonly isRetrying: boolean;
    readonly error?: string;
  };
}

interface AbandonAction {
  readonly onAbandon: () => void;
  readonly isAbandoning: boolean;
  readonly error?: string;
}

/** A collapsed single-unit stage. Its optional retry still targets that one unit; it is never a stage-wide command. */
export function RunStageRow({ stage, unitState, onSelectArtifact, retry, abandon, workers, onRetryWorker }: RunStageRowProps) {
  return (
    <tr className={stageRowClass(stage.status)} data-testid="or-stage-row">
      <td className={`${tableCellClass} font-medium text-[var(--text-primary)]`} data-testid="or-stage-name">{stage.name}</td>
      <td className={`${tableCellClass} text-[var(--text-secondary)]`}>{stage.type}</td>
      <td className={tableCellClass}><div className="flex items-center gap-2">
        <StatusBadge status={stage.status} />
        {unitState && <Chip tone="muted" testId="or-unit-state">{unitState}</Chip>}
        {stage.status === "blocked" && <Chip tone="warning" testId="or-stage-blocked-reason">
          {stage.blocked_reason} · next: {stage.next_actor}
        </Chip>}
        <CohortWorkers workers={workers} onRetry={onRetryWorker} retrying={retry?.isRetrying ?? false} />
        {abandon && <Button size="xsmall" variant="danger" onClick={abandon.onAbandon} disabled={abandon.isAbandoning}
          data-testid="or-abandon-unit-btn">{abandon.isAbandoning ? "Abandoning…" : "Abandon"}</Button>}
        {abandon?.error && <span role="alert" className="text-xs text-red-500">{abandon.error}</span>}
        {retry?.error && <span role="alert" className="text-xs text-red-500">{retry.error}</span>}
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
  onRetry: (unitId: string, worker: V15WorkerKey) => void;
  retrying: boolean;
  retryError?: string;
  canRetry: boolean;
  abandon?: AbandonAction;
  confirmMerge?: {
    readonly onConfirm: () => void;
    readonly isConfirming: boolean;
    readonly error?: string;
  };
}

export function RunUnitRow({ stageName, stageType, unit, unitArtifacts, onSelectArtifact, onRetry, retrying, retryError, abandon, confirmMerge }: RunUnitRowProps) {
  const brief = selectCohortBrief(unit);
  return (
    <tr className={stageRowClass(unit.status)} data-testid="or-stage-row">
      <td className={`${tableCellClass} font-medium text-[var(--text-primary)]`} data-testid="or-stage-name">
        <span>{stageName}</span>
        {unit.repository_key && <Chip tone="neutral" className="ml-1.5">{unit.repository_key}</Chip>}
        <Chip tone="muted" className="ml-1.5 font-mono">{unit.unit_id}</Chip>
        {brief?.title && <div className="mt-1 text-xs font-normal text-[var(--text-muted)]" data-testid="or-cohort-title">{brief.title}</div>}
      </td>
      <td className={`${tableCellClass} text-[var(--text-secondary)]`}>{stageType}</td>
      <td className={tableCellClass}><div className="flex items-center gap-2">
        <StatusBadge status={unit.status} />
        {unit.state && <Chip tone="muted" testId="or-unit-state">{unit.state}</Chip>}
        {unit.status === "blocked" && <Chip tone="warning" testId="or-unit-blocked-reason">
          {unit.blocked_reason} · next: {unit.next_actor}
        </Chip>}
        {unit.gate && <Chip tone="warning">{unit.gate}</Chip>}
        <CohortWorkers workers={unit.workers} onRetry={(worker) => onRetry(unit.unit_id, worker)} retrying={retrying} />
        {abandon && <Button size="xsmall" variant="danger" onClick={abandon.onAbandon} disabled={abandon.isAbandoning}
          data-testid="or-abandon-unit-btn">{abandon.isAbandoning ? "Abandoning…" : "Abandon"}</Button>}
        {abandon?.error && <span role="alert" className="text-xs text-red-500">{abandon.error}</span>}
        {retryError && <span role="alert" className="text-xs text-red-500">{retryError}</span>}
        {confirmMerge && (
          <Button
            size="xsmall"
            variant="accent-outline"
            onClick={confirmMerge.onConfirm}
            disabled={confirmMerge.isConfirming}
            data-testid="or-confirm-cohort-merged-btn"
          >
            {confirmMerge.isConfirming ? "Confirming…" : "Confirm merge"}
          </Button>
        )}
        {confirmMerge?.error && <span role="alert" className="text-xs text-red-500">{confirmMerge.error}</span>}
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
    <div className="flex flex-wrap gap-1.5">{artifacts.map((artifact) => onSelectArtifact ? <Button key={artifact.id} variant="link" onClick={() => onSelectArtifact(artifact.id)}><Chip tone="accent" className="underline">{artifact.type_id}</Chip></Button> : <Chip key={artifact.id} tone="neutral">{artifact.type_id}</Chip>)}</div>
  </td>;
}

function SessionCell({ sid }: { sid?: string | null }) {
  return <td className={tableCellClass} data-testid="or-stage-session">{sid ? <a href={`#sid=${encodeURIComponent(sid)}`} className="text-[var(--accent-blue)] underline" data-testid="or-delegated-session-link">{sid.slice(0, 8)}</a> : <span className={mutedClass}>-</span>}</td>;
}

function WorktreeCell({ worktree }: { worktree?: StageDetail["worktree"] }) {
  return <td className={tableCellClass} data-testid="or-stage-worktree">{worktree ? <div className="flex flex-col gap-1"><code className={codeClass} data-testid="or-stage-branch">{worktree.branch}</code><code className={codeClass} data-testid="or-stage-path">{worktree.path}</code></div> : <span className={mutedClass}>-</span>}</td>;
}
