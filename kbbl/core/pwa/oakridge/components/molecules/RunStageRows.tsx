import type { StageDetail, StageUnit } from "../../types";
import { StatusBadge } from "../atoms/StatusBadge";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import { Fragment } from "react";
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
  onSelectArtifact?: (artifactId: string) => void;
  retry?: {
    readonly onRetry: () => void;
    readonly isRetrying: boolean;
    readonly error?: string;
  };
}

/** A collapsed single-unit stage. Its optional retry still targets that one unit; it is never a stage-wide command. */
export function RunStageRow({ stage, onSelectArtifact, retry }: RunStageRowProps) {
  return (
    <tr className={stageRowClass(stage.status)} data-testid="or-stage-row">
      <td className={`${tableCellClass} font-medium text-[var(--text-primary)]`} data-testid="or-stage-name">{stage.name}</td>
      <td className={`${tableCellClass} text-[var(--text-secondary)]`}>{stage.type}</td>
      <td className={tableCellClass}><div className="flex items-center gap-2">
        <StatusBadge status={stage.status} />
        {stage.status === "blocked" && <Chip tone="warning" testId="or-stage-blocked-reason">
          {stage.blocked_reason} · next: {stage.next_actor}
        </Chip>}
        {retry && <Button size="xsmall" variant="danger" onClick={retry.onRetry} disabled={retry.isRetrying} data-testid="or-retry-unit-btn">{retry.isRetrying ? "Retrying…" : "Retry"}</Button>}
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
  onAdmit: (unitId: string) => void;
  admitting: boolean;
  admissionError?: string;
  onRetry: (unitId: string) => void;
  retrying: boolean;
  retryError?: string;
  canRetry: boolean;
  confirmMerge?: {
    readonly onConfirm: () => void;
    readonly isConfirming: boolean;
    readonly error?: string;
  };
}

export function RunUnitRow({ stageName, stageType, unit, unitArtifacts, onSelectArtifact, onAdmit, admitting, admissionError, onRetry, retrying, retryError, canRetry, confirmMerge }: RunUnitRowProps) {
  const blockedBy = unit.admission_blocked_by ?? [];
  const brief = selectCohortBrief(unit);
  const dependencies = brief?.depends_on ?? [];
  const needsAdmission = unit.status === "pending" && unit.admission_required === true && unit.admitted !== true;
  return (
    <Fragment>
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
        {unit.status === "blocked" && <Chip tone="warning" testId="or-unit-blocked-reason">
          {unit.blocked_reason} · next: {unit.next_actor}
        </Chip>}
        {unit.gate && <Chip tone="warning">{unit.gate}</Chip>}
        {unit.admission_required && unit.admitted && <span className="text-xs text-emerald-500" data-testid="or-unit-admitted">Admitted</span>}
        {canRetry && <Button size="xsmall" variant="danger" onClick={() => onRetry(unit.unit_id)} disabled={retrying} data-testid="or-retry-unit-btn">{retrying ? "Retrying…" : "Retry"}</Button>}
        {retryError && <span role="alert" className="text-xs text-red-500">{retryError}</span>}
        {confirmMerge && (
          <Button
            size="xsmall"
            variant="accent-outline"
            onClick={confirmMerge.onConfirm}
            disabled={confirmMerge.isConfirming}
            data-testid="or-confirm-cohort-merged-btn"
          >
            {confirmMerge.isConfirming ? "Confirming…" : "It’s merged — continue"}
          </Button>
        )}
        {confirmMerge?.error && <span role="alert" className="text-xs text-red-500">{confirmMerge.error}</span>}
      </div></td>
      <ArtifactCell artifacts={unitArtifacts} onSelectArtifact={onSelectArtifact} />
      <SessionCell sid={unit.sid} />
      <WorktreeCell worktree={unit.worktree} />
    </tr>
    {(dependencies.length > 0 || needsAdmission) && (
      <tr data-testid="or-cohort-detail-row">
        <td colSpan={6} className={`${tableCellClass} bg-[var(--bg-surface)]`}>
          <div className="flex flex-col gap-3">
            {dependencies.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="or-dependency-status">
                <span className="font-semibold uppercase text-[var(--text-muted)]">Dependency status</span>
                {dependencies.map((dependency) => {
                  const isBlocked = blockedBy.includes(dependency);
                  return (
                    <Chip key={dependency} tone={isBlocked ? "warning" : "success"}>
                      {dependency}: {isBlocked ? "waiting" : "complete"}
                    </Chip>
                  );
                })}
              </div>
            )}
            {needsAdmission && (
              <div className="flex flex-wrap items-center gap-3" data-testid="or-unit-admission">
                {blockedBy.length > 0 || unit.admission_eligible !== true ? (
                  <div className="text-sm text-amber-500" data-testid="or-admission-blocked">
                    Blocked by: {blockedBy.length > 0 ? blockedBy.join(", ") : "dependencies not yet complete"}
                  </div>
                ) : (
                  <Button size="medium" variant="accent-outline" onClick={() => onAdmit(unit.unit_id)} disabled={admitting} data-testid="or-admit-unit-btn">
                    {admitting ? "Admitting…" : "Admit build"}
                  </Button>
                )}
                {admissionError && <span role="alert" className="text-sm text-red-500">{admissionError}</span>}
              </div>
            )}
          </div>
        </td>
      </tr>
    )}
    </Fragment>
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
