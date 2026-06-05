/**
 * One row in the cell list sidebar. Shows task name, status
 * pill, condition + event count, and the run timestamp. Highlights
 * when selected.
 *
 * The <li> is a flex container: the selection <button> (flex-1) sits
 * beside a separate actions cluster so clicking Archive/Restore/Delete
 * does NOT also select the row. Action buttons call e.stopPropagation()
 * defensively. Nesting a <button> inside a <button> is invalid HTML, so
 * the two are siblings, not nested.
 *
 * Action affordances per row:
 *   - Archive:  shown when cell.archived === false (always enabled)
 *   - Restore:  shown when cell.archived === true
 *   - Delete:   shown when cell.archived === false;
 *               enabled only when cell.cleanable === true;
 *               disabled with tooltip "Run still in progress" otherwise
 *               (tooltip carried by a wrapper <span> since disabled
 *               buttons don't receive pointer events);
 *               requires window.confirm naming task/condition/run_ts.
 */
import { StatusPill } from "../atoms/StatusPill";
import type { CellSummary } from "../../lib/types";
import type { CellId } from "../../lib/ids";

export function CellRow({
  cell,
  selected,
  onSelect,
  onArchive,
  onRestore,
  onDelete,
}: {
  cell: CellSummary;
  selected: boolean;
  onSelect: () => void;
  onArchive: (id: CellId) => void;
  onRestore: (id: CellId) => void;
  onDelete: (id: CellId) => void;
}) {
  return (
    <li className="flex items-stretch border-b border-stone-200">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`min-w-0 flex-1 cursor-pointer border-0 px-4 py-2.5 text-left text-[13px] ${
          selected ? "bg-sky-100" : "bg-transparent"
        }`}
      >
        <div className="flex items-center justify-between gap-1">
          <span className="truncate font-semibold">{cell.target_name}</span>
          <StatusPill status={cell.status} />
        </div>
        <div className="mt-0.5 truncate text-[11px] text-stone-600">
          {cell.condition_name} · {cell.event_count} events
        </div>
        <div className="mt-0.5 text-[11px] text-stone-600">{cell.run_ts}</div>
      </button>

      <div className="flex flex-col items-center justify-center gap-0.5 border-l border-stone-200 px-1.5 py-1">
        {!cell.archived ? (
          <button
            type="button"
            aria-label="Archive"
            onClick={(e) => {
              e.stopPropagation();
              void onArchive(cell.cell_id);
            }}
            className="rounded px-1.5 py-0.5 text-[10px] text-stone-500 hover:bg-stone-200"
            title="Archive"
          >
            Arch
          </button>
        ) : (
          <button
            type="button"
            aria-label="Restore"
            onClick={(e) => {
              e.stopPropagation();
              void onRestore(cell.cell_id);
            }}
            className="rounded px-1.5 py-0.5 text-[10px] text-stone-500 hover:bg-stone-200"
            title="Restore"
          >
            Rst
          </button>
        )}

        {!cell.archived && (
          <span title={cell.cleanable ? undefined : "Run still in progress"}>
            <button
              type="button"
              aria-label="Delete permanently"
              disabled={!cell.cleanable}
              onClick={(e) => {
                e.stopPropagation();
                const ok = window.confirm(
                  `Permanently delete ${cell.target_name} × ${cell.condition_name} from run ${cell.run_ts}? This removes its output from disk and cannot be undone.`,
                );
                if (ok) void onDelete(cell.cell_id);
              }}
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                cell.cleanable
                  ? "text-red-600 hover:bg-red-100"
                  : "cursor-not-allowed text-stone-300"
              }`}
              title={cell.cleanable ? "Delete permanently" : undefined}
            >
              Del
            </button>
          </span>
        )}
      </div>
    </li>
  );
}
