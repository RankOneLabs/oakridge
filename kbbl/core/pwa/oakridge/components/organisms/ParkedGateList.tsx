import { Button } from "../../../components/atoms/Button";
import { useQueryClient } from "@tanstack/react-query";
import { useGates } from "../../hooks/useGates";
import type { ParkedGate } from "../../types";
import { GateDecisionActions } from "./GateDecisionActions";

const chipClass =
  "inline-block rounded border border-[var(--border-muted)] bg-[var(--bg-surface)] px-2 py-0.5 text-xs font-medium text-[var(--text-secondary)]";
const labelClass = "text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]";
const codeClass =
  "rounded bg-[var(--bg-code)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-secondary)]";

interface GateCardProps {
  gate: ParkedGate;
  onNavigateRun?: (runId: string) => void;
  onNavigateArtifact?: (artifactRevisionId: string) => void;
}

function gateTypeLabel(gateType: string): string {
  if (gateType === "artifact_approval") return "Artifact review";
  if (gateType === "merge_confirmation") return "Merge confirmation";
  return "Operator decision";
}

function GateCard({ gate, onNavigateRun, onNavigateArtifact }: GateCardProps) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-4${gate.actionable ? "" : " or-gate-card--stranded"}`}
      data-testid="or-gate-card"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span className={chipClass} data-testid="or-gate-type">{gateTypeLabel(gate.gate_type)}</span>
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
        {gate.repository_key && (
          <span className={chipClass} data-testid="or-gate-repository">
            Repository: {gate.repository_key}
          </span>
        )}
        {onNavigateRun && (
          <Button variant="link"
            type="button"
            className="text-sm"
            onClick={() => onNavigateRun(gate.run_id)}
            data-testid="or-gate-run-link"
          >
            Run {gate.run_id.slice(0, 8)}
          </Button>
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

      {gate.pr_url && /^https?:\/\//i.test(gate.pr_url) && (
        <div className="flex items-center gap-2" data-testid="or-gate-pr-url">
          <span className={labelClass}>PR</span>
          <a
            href={gate.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-[var(--accent-blue)] underline"
          >
            {gate.pr_url}
          </a>
        </div>
      )}

      {gate.artifact_revision_id && (
        <div className="flex items-center gap-2">
          <span className={labelClass}>Revision</span>
          {onNavigateArtifact ? (
            <Button variant="link"
              type="button"
              className="font-mono text-xs"
              onClick={() => onNavigateArtifact(gate.artifact_revision_id!)}
              data-testid="or-gate-artifact-link"
            >
              {gate.artifact_revision_id}
            </Button>
          ) : <code className={codeClass}>{gate.artifact_revision_id}</code>}
        </div>
      )}

      <GateDecisionActions gate={gate} />
    </div>
  );
}

export function GlobalParkedGateList({ onNavigateRun, onNavigateArtifact }: { onNavigateRun: (id: string) => void; onNavigateArtifact?: (id: string) => void }) {
  const qc = useQueryClient();
  const query = useGates();

  return (
    <div className="flex flex-col gap-3" data-testid="or-global-gate-list">
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-lg font-semibold text-[var(--text-primary)]">Needs attention</h2>
        <Button variant="secondary"
          type="button"
          onClick={() => { void qc.invalidateQueries({ queryKey: ["oakridge", "gates"] }); }}
        >
          Refresh
        </Button>
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
          Nothing needs a decision.
        </div>
      )}

      {query.data && query.data.map((gate: ParkedGate) => (
        <GateCard key={gate.id} gate={gate} onNavigateRun={onNavigateRun} onNavigateArtifact={onNavigateArtifact} />
      ))}
    </div>
  );
}

export function RunParkedGateList({ gates }: { gates: readonly ParkedGate[] }) {
  if (gates.length === 0) return null;

  return (
    <div className="mt-6 flex flex-col gap-3" data-testid="or-run-gate-list">
      <h3 className="mb-2 mt-0 text-sm font-semibold text-[var(--text-secondary)]">Needs attention</h3>
      {gates.map((gate: ParkedGate) => (
        <GateCard key={gate.id} gate={gate} />
      ))}
    </div>
  );
}
