/**
 * Sidebar listing every cell. Highlights the selected one and
 * shows a placeholder when no cells exist yet.
 */
import { EmptyMessage } from "../atoms/EmptyMessage";
import { CellRow } from "../molecules/CellRow";
import type { CellSummary } from "../../lib/types";

export function CellList({
  cells,
  selectedId,
  onSelect,
}: {
  cells: CellSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="w-72 overflow-auto border-r border-stone-300 bg-stone-50 py-3">
      <h2 className="mx-4 mb-3 text-xs uppercase tracking-wide text-stone-600">
        cells
      </h2>
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
            />
          ))}
        </ul>
      )}
    </aside>
  );
}
