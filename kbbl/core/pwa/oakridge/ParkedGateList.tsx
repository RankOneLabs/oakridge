import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGates, useRunGates } from "./hooks";
import type { ParkedGate } from "./types";
import { GateResumeForm } from "./GateResumeForm";

interface GateCardProps {
  gate: ParkedGate;
  onNavigateRun?: (runId: string) => void;
}

function GateCard({ gate, onNavigateRun }: GateCardProps) {
  const [showResume, setShowResume] = useState(false);

  return (
    <div className="or-gate-card" data-testid="or-gate-card">
      <div className="or-gate-card__meta">
        <span className="or-chip or-chip--gate-type" data-testid="or-gate-type">{gate.gate_type}</span>
        <span className="or-gate-card__stage" data-testid="or-gate-stage">{gate.stage_name}</span>
        {onNavigateRun && (
          <button
            type="button"
            className="or-link"
            onClick={() => onNavigateRun(gate.run_id)}
            data-testid="or-gate-run-link"
          >
            Run {gate.run_id.slice(0, 8)}
          </button>
        )}
      </div>

      {gate.worktree && (
        <div className="or-gate-card__worktree" data-testid="or-gate-worktree">
          <span className="or-label">Branch</span>
          <code className="or-code" data-testid="or-gate-branch">{gate.worktree.branch}</code>
          <span className="or-label">Path</span>
          <code className="or-code" data-testid="or-gate-path">{gate.worktree.path}</code>
          <span className="or-label">Base</span>
          <code className="or-code">{gate.worktree.base_ref}</code>
        </div>
      )}

      {gate.artifact_revision_id && (
        <div className="or-gate-card__revision">
          <span className="or-label">Revision</span>
          <code className="or-code">{gate.artifact_revision_id}</code>
        </div>
      )}

      {!showResume && (
        <button
          type="button"
          className="or-btn or-btn--primary or-gate-card__resume-btn"
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

// Global parked gate list
export function GlobalParkedGateList({ onNavigateRun }: { onNavigateRun: (id: string) => void }) {
  const qc = useQueryClient();
  const query = useGates();

  return (
    <div className="or-gate-list" data-testid="or-global-gate-list">
      <div className="or-gate-list__header">
        <h2 className="or-gate-list__title">Parked Gates</h2>
        <button
          type="button"
          className="or-btn or-btn--secondary"
          onClick={() => qc.invalidateQueries({ queryKey: ["oakridge", "gates"] })}
        >
          Refresh
        </button>
      </div>

      {query.isError && (
        <div className="or-error" role="alert" data-testid="or-gate-list-error">
          {query.error instanceof Error ? query.error.message : "Failed to load gates"}
        </div>
      )}

      {query.isPending && !query.data && (
        <div className="or-loading">Loading gates…</div>
      )}

      {query.data && query.data.length === 0 && (
        <div className="or-empty" data-testid="or-gate-list-empty">No parked gates.</div>
      )}

      {query.data && query.data.map((gate: ParkedGate) => (
        <GateCard key={gate.id} gate={gate} onNavigateRun={onNavigateRun} />
      ))}
    </div>
  );
}

// Per-run parked gate list (used inside RunDetailView)
export function RunParkedGateList({ runId }: { runId: string }) {
  const query = useRunGates(runId);

  if (query.isPending && !query.data) return null;
  if (!query.data || query.data.length === 0) return null;

  return (
    <div className="or-gate-list or-gate-list--inline" data-testid="or-run-gate-list">
      <h3 className="or-gate-list__subtitle">Parked Gates</h3>
      {query.data.map((gate: ParkedGate) => (
        <GateCard key={gate.id} gate={gate} />
      ))}
    </div>
  );
}
