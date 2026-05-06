/**
 * One row in the scores table — dimension name, value rendered as
 * a 0–1.0 number with a small color-graded bar, and the source
 * tag. Composed by the CellPanel's ScoresView block.
 */
import type { EvalScore } from "../../lib/types";

function valueColor(v: number): string {
  // Cheap traffic-light gradient: red below 0.5, amber 0.5–0.85, green above.
  if (v >= 0.85) return "bg-emerald-500";
  if (v >= 0.5) return "bg-amber-500";
  return "bg-rose-500";
}

export function ScoreRow({ score }: { score: EvalScore }) {
  const pct = Math.max(0, Math.min(1, score.value)) * 100;
  return (
    <li className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-stone-100 py-2 text-[13px]">
      <span className="text-stone-800">{score.dimension}</span>
      <div className="flex items-center gap-2">
        <span className="font-mono tabular-nums text-stone-700">
          {score.value.toFixed(3)}
        </span>
        <div className="relative h-2 w-24 overflow-hidden rounded-full bg-stone-200">
          <div
            className={`absolute inset-y-0 left-0 ${valueColor(score.value)}`}
            style={{ width: `${pct}%` }}
            aria-hidden
          />
        </div>
      </div>
      <span className="text-[11px] uppercase tracking-wide text-stone-500">
        {score.source}
      </span>
    </li>
  );
}
