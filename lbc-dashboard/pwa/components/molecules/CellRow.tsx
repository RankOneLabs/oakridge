/**
 * One row in the cell list sidebar. Shows task name, status
 * pill, condition + event count, and the run timestamp. Highlights
 * when selected.
 *
 * Interaction lives on a real ``<button>`` inside the ``<li>`` so
 * keyboard users can focus and Enter/Space to select. ``aria-pressed``
 * reflects the selected state for assistive tech.
 */
import { StatusPill } from "../atoms/StatusPill";
import type { CellSummary } from "../../lib/types";

export function CellRow({
  cell,
  selected,
  onSelect,
}: {
  cell: CellSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li className="border-b border-stone-200">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`block w-full cursor-pointer border-0 px-4 py-2.5 text-left text-[13px] ${
          selected ? "bg-sky-100" : "bg-transparent"
        }`}
      >
        <div className="flex items-center justify-between">
          <span className="font-semibold">{cell.target_name}</span>
          <StatusPill status={cell.status} />
        </div>
        <div className="mt-0.5 text-[11px] text-stone-600">
          {cell.condition_name} · {cell.event_count} events
        </div>
        <div className="mt-0.5 text-[11px] text-stone-600">{cell.run_ts}</div>
      </button>
    </li>
  );
}
