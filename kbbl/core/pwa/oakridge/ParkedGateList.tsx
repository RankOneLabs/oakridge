import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGates, useRunGates } from "./hooks";
import type { ParkedGate } from "./types";
import { GateResumeForm } from "./GateResumeForm";

const primaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--accent-blue)] bg-[var(--accent-blue)] px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:border-[var(--border-muted)] disabled:bg-[var(--border-muted)] disabled:text-[var(--text-fainter)]";
const secondaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--border-muted)] bg-transparent px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:border-[var(--border-hover)]";
const chipClass =
  "inline-block rounded border border-[var(--border-muted)] bg-[var(--bg-surface)] px-2 py-0.5 text-xs font-medium text-[var(--text-secondary)]";
const labelClass = "text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]";
const codeClass =
  "rounded bg-[var(--bg-code)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-secondary)]";

interface GateCardProps {
  gate: ParkedGate;
  onNavigateRun?: (runId: string) => void;
}

function GateCard({ gate, onNavigateRun }: GateCardProps) {
  const [showResume, setShowResume] = useState(false);

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-4"
      data-testid="or-gate-card"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span className={chipClass} data-testid="or-gate-type">{gate.gate_type}</span>
        <span className="text-sm text-[var(--text-secondary)]" data-testid="or-gate-stage">
          {gate.stage_name}
        </span>
        {gate.unit_id && gate.unit_id !== "0" && (
          <span
            className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-xs font-mono text-[var(--text-muted)]"
            data-testid="or-gate-unit-id"
          >
            {gate.unit_id}
          </span>
        )}
        {onNavigateRun && (
          <button
            type="button"
            className="border-0 bg-transparent p-0 text-sm text-[var(--accent-blue)] underline"
            onClick={() => onNavigateRun(gate.run_id)}
            data-testid="or-gate-run-link"
          >
            Run {gate.run_id.slice(0, 8)}
          </button>
        )}
      </div>

      {gate.worktree && (
        <div className="flex flex-wrap items-center gap-2" data-testid="or-gate-worktree">
          <span className={labelClass}>Branch</span>
          <code className={codeClass} data-testid="or-gate-branch">{gate.worktree.branch}</code>
          <span className={labelClass}>Path</span>
          <code className={codeClass} data-testid="or-gate-path">{gate.worktree.path}</code>
          <span className={labelClass}>Base</span>
          <code className={codeClass}>{gate.worktree.base_ref}</code>
        </div>
      )}

      {gate.artifact_revision_id && (
        <div className="flex items-center gap-2">
          <span className={labelClass}>Revision</span>
          <code className={codeClass}>{gate.artifact_revision_id}</code>
        </div>
      )}

      {!showResume && (
        <button
          type="button"
          className={primaryButtonClass}
          onClick={() => setShowResume(true)}
          data-testid="or-gate-resume-btn"
        >
          Resume gate
        </button>
      )}

      {showResume && (
        <GateResumeForm gate={gate} onDone={() => setShowResume(false)} />
      )}
    </div>
  );
}

export function GlobalParkedGateList({ onNavigateRun }: { onNavigateRun: (id: string) => void }) {
  const qc = useQueryClient();
  const query = useGates();

  return (
    <div className="flex flex-col gap-3" data-testid="or-global-gate-list">
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-lg font-semibold text-[var(--text-primary)]">Parked Gates</h2>
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() => { void qc.invalidateQueries({ queryKey: ["oakridge", "gates"] }); }}
        >
          Refresh
        </button>
      </div>

      {query.isError && (
        <div
          className="rounded-md border border-[var(--danger-card-border)] bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger-fg)]"
          role="alert"
          data-testid="or-gate-list-error"
        >
          {query.error instanceof Error ? query.error.message : "Failed to load gates"}
        </div>
      )}

      {query.isPending && !query.data && (
        <div className="py-6 text-sm text-[var(--text-muted)]">Loading gates…</div>
      )}

      {query.data && query.data.length === 0 && (
        <div className="py-6 text-sm text-[var(--text-muted)]" data-testid="or-gate-list-empty">
          No parked gates.
        </div>
      )}

      {query.data && query.data.map((gate: ParkedGate) => (
        <GateCard key={gate.id} gate={gate} onNavigateRun={onNavigateRun} />
      ))}
    </div>
  );
}

export function RunParkedGateList({ runId }: { runId: string }) {
  const query = useRunGates(runId);

  if (query.isPending && !query.data) return null;
  if (!query.data || query.data.length === 0) return null;

  return (
    <div className="mt-6 flex flex-col gap-3" data-testid="or-run-gate-list">
      <h3 className="mb-2 mt-0 text-sm font-semibold text-[var(--text-secondary)]">Parked Gates</h3>
      {query.data.map((gate: ParkedGate) => (
        <GateCard key={gate.id} gate={gate} />
      ))}
    </div>
  );
}
