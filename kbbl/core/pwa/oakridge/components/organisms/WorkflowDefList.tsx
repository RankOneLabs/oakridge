import { useState } from "react";
import { useWorkflowDefs } from "../../hooks/useWorkflowDefs";
import { useSetWorkflowDefArchived } from "../../hooks/useSetWorkflowDefArchived";
import type { WorkflowDefSummary } from "../../types";
import { Button } from "../atoms/Button";
import { FeedbackMessage } from "../atoms/FeedbackMessage";
import { PageHeader } from "../molecules/PageHeader";
const tableHeaderClass =
  "border-b border-[var(--border-subtle)] px-3 py-2 text-left text-xs font-semibold uppercase text-[var(--text-muted)]";
const tableCellClass =
  "border-b border-[var(--border-subtle)] px-3 py-2.5 align-middle";

interface WorkflowDefListProps {
  onNew: () => void;
  onSelect: (def: WorkflowDefSummary) => void;
  onClone: (def: WorkflowDefSummary) => void;
}

export function WorkflowDefList({ onNew, onSelect, onClone }: WorkflowDefListProps) {
  const [showRetired, setShowRetired] = useState(false);
  const query = useWorkflowDefs(showRetired);
  const setArchived = useSetWorkflowDefArchived();

  // Group defs by name, latest version first within each name
  const grouped: WorkflowDefSummary[] = query.data
    ? [...query.data].sort((a, b) => {
        if (a.name !== b.name) return a.name.localeCompare(b.name);
        return b.version - a.version;
      })
    : [];

  return (
    <div className="or-page or-page--wide" data-testid="or-def-list">
      <PageHeader
        eyebrow="Reusable orchestration"
        title="Workflows"
        summary="Inspect versioned definitions or compose a new execution graph."
        actions={<>
          <label className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={showRetired}
              onChange={(e) => setShowRetired(e.target.checked)}
              data-testid="or-def-show-retired"
            />
            Show retired
          </label>
          <Button variant="primary" onClick={onNew} data-testid="or-def-new-btn">
            + New Definition
          </Button>
        </>}
      />

      {query.isError && (
        <FeedbackMessage tone="danger" testId="or-def-list-error">
          {query.error instanceof Error ? query.error.message : "Failed to load workflow definitions"}
        </FeedbackMessage>
      )}

      {/* Retire/restore failures would otherwise be invisible: the mutation just
          re-enables the button and the row keeps its old state. */}
      {setArchived.isError && (
        <FeedbackMessage tone="danger" testId="or-def-archive-error">
          {setArchived.error instanceof Error
            ? setArchived.error.message
            : "Failed to change the retired state of this definition"}
        </FeedbackMessage>
      )}

      {query.isPending && !query.data && (
        <FeedbackMessage testId="or-def-list-loading">Loading definitions…</FeedbackMessage>
      )}

      {query.data && query.data.length === 0 && (
        <FeedbackMessage testId="or-def-list-empty">No workflow definitions found. Create one to get started.</FeedbackMessage>
      )}

      {grouped.length > 0 && (
        <table className="or-data-table w-full border-collapse text-sm" aria-label="Workflow definitions">
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
                  <button
                    type="button"
                    className="or-def-list__link"
                    onClick={() => onSelect(def)}
                    data-testid="or-def-view-btn"
                  >
                    {def.name}
                  </button>
                </td>
                <td className={`${tableCellClass} text-[var(--text-secondary)]`}>
                  v{def.version}
                  {def.archived && (
                    <span
                      className="ml-2 rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-xs text-[var(--text-muted)]"
                      data-testid="or-def-retired-badge"
                    >
                      retired
                    </span>
                  )}
                </td>
                <td className={`${tableCellClass} font-mono text-xs text-[var(--text-muted)]`}>
                  {def.id.slice(0, 8)}…
                </td>
                <td className={tableCellClass}>
                  <div className="or-def-list__actions">
                    <Button onClick={() => onSelect(def)}>View</Button>
                    <Button
                      onClick={() => onClone(def)}
                      data-testid="or-def-clone-btn"
                    >
                      Clone to new version
                    </Button>
                    <Button
                      onClick={() =>
                        setArchived.mutate({ defId: def.id, archived: !def.archived })
                      }
                      disabled={setArchived.isPending}
                      data-testid="or-def-archive-btn"
                    >
                      {def.archived ? "Restore" : "Retire"}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
