/**
 * Tiny status indicator for cell rows. ``active`` is greenish,
 * ``ended`` is neutral grey, ``failed`` is red, ``unknown`` is amber.
 * Used in the cell list and the cell panel header.
 */
import type { CellSummary } from "../../lib/types";

const VARIANTS: Record<CellSummary["status"], string> = {
  active: "bg-emerald-600",
  ended: "bg-stone-400",
  failed: "bg-red-600",
  unknown: "bg-amber-500",
};

export function StatusPill({ status }: { status: CellSummary["status"] }) {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white ${VARIANTS[status]}`}
    >
      {status}
    </span>
  );
}
