/**
 * Sidebar listing every cell. Highlights the selected one and
 * shows a placeholder when no cells exist yet.
 *
 * A three-state segmented control in the sidebar header drives the
 * archive filter:
 *   Active   → default (active + completed non-archived)
 *   All      → include (all cells)
 *   Archived → only (archived only)
 * The filter state lives in App and is threaded in via props so
 * useCells can build the correct /api/cells?archived=... URL.
 */
import { EmptyMessage } from "../atoms/EmptyMessage";
import { CellRow } from "../molecules/CellRow";
import type { CellSummary, CellArchiveFilter } from "../../lib/types";
import type { CellId } from "../../lib/ids";

const FILTER_OPTIONS: Array<{ value: CellArchiveFilter; label: string }> = [
  { value: "default", label: "Active" },
  { value: "include", label: "All" },
  { value: "only", label: "Archived" },
];

export function CellList({
  cells,
  selectedId,
  onSelect,
  filter,
  onFilterChange,
  onArchive,
  onRestore,
  onDelete,
}: {
  cells: CellSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  filter: CellArchiveFilter;
  onFilterChange: (f: CellArchiveFilter) => void;
  onArchive: (id: CellId) => void;
  onRestore: (id: CellId) => void;
  onDelete: (id: CellId) => void;
}) {
  return (
    <aside className="w-72 overflow-auto border-r border-stone-300 bg-stone-50 py-3">
      <div className="mx-4 mb-3 flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-wide text-stone-600">
          cells
        </h2>
        <div role="group" aria-label="Archive filter" className="flex gap-0.5">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={filter === opt.value}
              onClick={() => onFilterChange(opt.value)}
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                filter === opt.value
                  ? "bg-sky-600 text-white"
                  : "text-stone-500 hover:bg-stone-200"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      {cells.length === 0 ? (
        <EmptyMessage>
          No cells yet. Run a project from{" "}
          <code className="font-mono text-stone-700">
            scripts/run_one_project.py
          </code>
          .
        </EmptyMessage>
      ) : (
        <ul className="m-0 list-none p-0">
          {cells.map((c) => (
            <CellRow
              key={c.cell_id}
              cell={c}
              selected={c.cell_id === selectedId}
              onSelect={() => onSelect(c.cell_id)}
              onArchive={onArchive}
              onRestore={onRestore}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}
