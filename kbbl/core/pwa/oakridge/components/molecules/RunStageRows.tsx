import type { StageDetail, StageUnit } from "../../types";
import { StatusBadge } from "../atoms/StatusBadge";
import { Fragment } from "react";
import { CohortBrief } from "./CohortBrief";

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
  onSelectArtifact?: (artifactId: string) => void;
}

/** A stage without unit rows. Retry is a per-unit operation (see `RunUnitRow`); a stage has no retry of its own. */
export function RunStageRow({ stage, onSelectArtifact }: RunStageRowProps) {
  return (
    <tr className={stageRowClass(stage.status)} data-testid="or-stage-row">
      <td className={`${tableCellClass} font-medium text-[var(--text-primary)]`} data-testid="or-stage-name">{stage.name}</td>
      <td className={`${tableCellClass} text-[var(--text-secondary)]`}>{stage.type}</td>
      <td className={tableCellClass}><div className="flex items-center gap-2">
        <StatusBadge status={stage.status} />
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
}

export function RunUnitRow({ stageName, stageType, unit, unitArtifacts, onSelectArtifact, onAdmit, admitting, admissionError, onRetry, retrying, retryError, canRetry }: RunUnitRowProps) {
  const blockedBy = unit.admission_blocked_by ?? [];
  const dependencies = unit.params?.depends_on ?? [];
  const needsAdmission = unit.status === "pending" && unit.admission_required === true && unit.admitted !== true;
  return (
    <Fragment>
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
        {unit.admission_required && unit.admitted && <span className="text-xs text-emerald-500" data-testid="or-unit-admitted">Admitted</span>}
        {canRetry && <button type="button" className="rounded border border-red-500 px-2 py-0.5 text-xs text-red-500 hover:bg-red-500 hover:text-white disabled:opacity-50" onClick={() => onRetry(unit.unit_id)} disabled={retrying} data-testid="or-retry-unit-btn">{retrying ? "Retrying…" : "Retry"}</button>}
        {retryError && <span role="alert" className="text-xs text-red-500">{retryError}</span>}
      </div></td>
      <ArtifactCell artifacts={unitArtifacts} onSelectArtifact={onSelectArtifact} />
      <SessionCell sid={unit.sid} />
      <WorktreeCell worktree={unit.worktree} />
    </tr>
    {(unit.params || needsAdmission) && (
      <tr data-testid="or-cohort-detail-row">
        <td colSpan={6} className={`${tableCellClass} bg-[var(--bg-surface)]`}>
          <div className="flex flex-col gap-3">
            <CohortBrief unit={unit} />
            {dependencies.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="or-dependency-status">
                <span className="font-semibold uppercase text-[var(--text-muted)]">Dependency status</span>
                {dependencies.map((dependency) => {
                  const isBlocked = blockedBy.includes(dependency);
                  return (
                    <span
                      key={dependency}
                      className={`rounded border px-1.5 py-0.5 ${isBlocked ? "border-amber-400 text-amber-500" : "border-emerald-500 text-emerald-500"}`}
                    >
                      {dependency}: {isBlocked ? "waiting" : "complete"}
                    </span>
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
                  <button type="button" className="rounded-md border border-[var(--accent-blue)] px-3 py-1.5 text-sm text-[var(--accent-blue)] disabled:opacity-50" onClick={() => onAdmit(unit.unit_id)} disabled={admitting} data-testid="or-admit-unit-btn">
                    {admitting ? "Admitting…" : "Admit build"}
                  </button>
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
    <div className="flex flex-wrap gap-1.5">{artifacts.map((artifact) => onSelectArtifact ? <button key={artifact.id} type="button" className={`${chipBaseClass} border-[var(--accent-blue)] text-[var(--accent-blue)] underline`} onClick={() => onSelectArtifact(artifact.id)}>{artifact.type_id}</button> : <span key={artifact.id} className={`${chipBaseClass} border-[var(--border-muted)] text-[var(--text-secondary)]`}>{artifact.type_id}</span>)}</div>
  </td>;
}

function SessionCell({ sid }: { sid?: string | null }) {
  return <td className={tableCellClass} data-testid="or-stage-session">{sid ? <a href={`#sid=${encodeURIComponent(sid)}`} className="text-[var(--accent-blue)] underline" data-testid="or-delegated-session-link">{sid.slice(0, 8)}</a> : <span className={mutedClass}>-</span>}</td>;
}

function WorktreeCell({ worktree }: { worktree?: StageDetail["worktree"] }) {
  return <td className={tableCellClass} data-testid="or-stage-worktree">{worktree ? <div className="flex flex-col gap-1"><code className={codeClass} data-testid="or-stage-branch">{worktree.branch}</code><code className={codeClass} data-testid="or-stage-path">{worktree.path}</code></div> : <span className={mutedClass}>-</span>}</td>;
}
