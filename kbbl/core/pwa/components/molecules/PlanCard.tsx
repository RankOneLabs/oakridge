import type { UiPlanEntry } from "../../types";

const STATUS_GLYPH: Record<string, string> = {
  completed: "✓",
  in_progress: "▸",
  pending: "○",
};

export function PlanCard({ entries }: { entries: readonly UiPlanEntry[] }) {
  return (
    <details className="card card-plan" open>
      <summary>
        <span className="card-label">plan</span>
        <span className="card-preview">
          {entries.filter((entry) => entry.status === "completed").length}/
          {entries.length} done
        </span>
      </summary>
      <ul className="card-plan-entries">
        {entries.map((entry, idx) => (
          <li
            key={`${idx}-${entry.content.slice(0, 24)}`}
            className={`card-plan-entry card-plan-entry-${entry.status}`}
          >
            <span aria-hidden="true">{STATUS_GLYPH[entry.status] ?? "·"} </span>
            {entry.content}
          </li>
        ))}
      </ul>
    </details>
  );
}
