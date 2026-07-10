import { useWorkflowDefs } from "./hooks";
import type { WorkflowDefSummary } from "./types";

const secondaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-[var(--border-muted)] bg-transparent px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:border-[var(--border-hover)]";
const primaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-md bg-[var(--accent-blue)] px-4 py-2 text-sm font-medium text-white hover:opacity-90";
const tableHeaderClass =
  "border-b border-[var(--border-subtle)] px-3 py-2 text-left text-xs font-semibold uppercase text-[var(--text-muted)]";
const tableCellClass =
  "border-b border-[var(--border-subtle)] px-3 py-2.5 align-middle";

interface WorkflowDefListViewProps {
  onNew: () => void;
  onClone: (def: WorkflowDefSummary) => void;
}

export function WorkflowDefListView({ onNew, onClone }: WorkflowDefListViewProps) {
  const query = useWorkflowDefs();

  // Group defs by name, latest version first within each name
  const grouped: WorkflowDefSummary[] = query.data
    ? [...query.data].sort((a, b) => {
        if (a.name !== b.name) return a.name.localeCompare(b.name);
        return b.version - a.version;
      })
    : [];

  return (
    <div data-testid="or-def-list">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="m-0 text-lg font-semibold text-[var(--text-primary)]">Workflow Definitions</h2>
        <button
          type="button"
          className={primaryButtonClass}
          onClick={onNew}
          data-testid="or-def-new-btn"
        >
          + New Definition
        </button>
      </div>

      {query.isError && (
        <div
          className="rounded-md border border-[var(--danger-card-border)] bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger-fg)]"
          role="alert"
          data-testid="or-def-list-error"
        >
          {query.error instanceof Error ? query.error.message : "Failed to load workflow definitions"}
        </div>
      )}

      {query.isPending && !query.data && (
        <div className="py-6 text-sm text-[var(--text-muted)]" data-testid="or-def-list-loading">
          Loading definitions…
        </div>
      )}

      {query.data && query.data.length === 0 && (
        <div className="py-6 text-sm text-[var(--text-muted)]" data-testid="or-def-list-empty">
          No workflow definitions found. Create one to get started.
        </div>
      )}

      {grouped.length > 0 && (
        <table className="w-full border-collapse text-sm" aria-label="Workflow definitions">
          <thead>
            <tr>
              <th className={tableHeaderClass}>Name</th>
              <th className={tableHeaderClass}>Version</th>
              <th className={tableHeaderClass}>ID</th>
              <th className={tableHeaderClass}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {grouped.map((def) => (
              <tr key={def.id} className="hover:bg-[var(--bg-elevated)]" data-testid="or-def-row">
                <td className={`${tableCellClass} font-medium text-[var(--text-primary)]`}>
                  {def.name}
                </td>
                <td className={`${tableCellClass} text-[var(--text-secondary)]`}>
                  v{def.version}
                </td>
                <td className={`${tableCellClass} font-mono text-xs text-[var(--text-muted)]`}>
                  {def.id.slice(0, 8)}…
                </td>
                <td className={tableCellClass}>
                  <button
                    type="button"
                    className={secondaryButtonClass}
                    onClick={() => onClone(def)}
                    data-testid="or-def-clone-btn"
                  >
                    Clone to new version
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
