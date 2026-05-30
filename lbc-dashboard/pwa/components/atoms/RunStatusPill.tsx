/**
 * Status indicator for runs. Three variants: running (amber),
 * exited (emerald), failed (red). Sibling of StatusPill — kept
 * separate so cell semantics (active|ended) stay unwidened.
 */
import type { RunStatus } from "../../lib/types";

const VARIANTS: Record<RunStatus, string> = {
  running: "bg-amber-500",
  exited: "bg-emerald-600",
  failed: "bg-red-600",
};

export function RunStatusPill({ status }: { status: RunStatus }) {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white ${VARIANTS[status]}`}
    >
      {status}
    </span>
  );
}
