/**
 * One row in the cell list sidebar. Shows target name, status
 * pill, condition + event count, and the run timestamp. Highlights
 * when selected.
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
    <li
      onClick={onSelect}
      className={`cursor-pointer border-b border-stone-200 px-4 py-2.5 text-[13px] ${
        selected ? "bg-sky-100" : ""
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
    </li>
  );
}
