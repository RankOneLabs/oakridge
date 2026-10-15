import { useId } from "react";
import { Button } from "../../../components/atoms/Button";
import { PLAN_GRAPH_NODE, type PlanGraphLayout } from "../../lib/plan-graph";
import type { CohortId } from "../../types";

interface Props {
  layout: PlanGraphLayout;
  selectedCohortId: CohortId | null;
  onSelectCohort: (id: CohortId) => void;
}

/**
 * The whole cohort graph at 1:1, scrolling with the page. Wider than the pane,
 * it scrolls sideways; it never pans or zooms, so no cohort can be out of view.
 */
export function PlanGraph({ layout, selectedCohortId, onSelectCohort }: Props) {
  const markerId = useId();
  const isActive = (from: CohortId, to: CohortId) => from === selectedCohortId || to === selectedCohortId;

  return (
    <div className="overflow-x-auto" data-testid="or-plan-graph">
      <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} className="mx-auto block max-w-none" role="group" aria-label="Cohort dependency graph">
        <defs>
          {(["idle", "active"] as const).map((state) => (
            <marker key={state} id={`${markerId}-${state}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" className={state === "active" ? "fill-[var(--accent-blue)]" : "fill-[var(--border-hover)]"} />
            </marker>
          ))}
        </defs>
        {layout.edges.map((edge) => {
          const state = isActive(edge.from, edge.to) ? "active" : "idle";
          return (
            <path
              key={`${edge.from}->${edge.to}`}
              d={edge.path}
              fill="none"
              strokeWidth={state === "active" ? 2 : 1.25}
              className={state === "active" ? "stroke-[var(--accent-blue)]" : "stroke-[var(--border-hover)]"}
              markerEnd={`url(#${markerId}-${state})`}
            />
          );
        })}
        {layout.nodes.map(({ cohort, x, y }) => {
          const isSelected = cohort.id === selectedCohortId;
          return (
            <foreignObject key={cohort.id} x={x} y={y} width={PLAN_GRAPH_NODE.width} height={PLAN_GRAPH_NODE.height}>
              <Button
                variant="secondary"
                size="small"
                // The secondary variant centres its content and sets the border colour; a graph node is a top-aligned card.
                className={`h-full w-full flex-col items-start! justify-start! gap-1 overflow-hidden py-2! text-left ${isSelected ? "border-[var(--accent-blue)]! ring-1 ring-[var(--accent-blue)]" : ""}`}
                aria-pressed={isSelected}
                title={cohort.title}
                data-testid="or-plan-graph-node"
                onClick={() => onSelectCohort(cohort.id)}
              >
                <span className="max-w-full truncate font-mono text-[0.6875rem] text-[var(--text-muted)]">{cohort.id}</span>
                <span className="line-clamp-3 text-xs font-medium leading-snug text-[var(--text-primary)]">{cohort.title}</span>
              </Button>
            </foreignObject>
          );
        })}
      </svg>
    </div>
  );
}
