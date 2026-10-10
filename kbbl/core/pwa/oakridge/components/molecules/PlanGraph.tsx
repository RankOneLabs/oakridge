import type { PlanGraphLayout } from "../../lib/plan-graph";

interface Props { readonly layout: PlanGraphLayout; readonly selectedId: string | null; readonly onSelect: (id: string) => void }
export function PlanGraph({ layout, selectedId, onSelect }: Props) {
  return <div className="overflow-x-auto" data-testid="or-plan-graph"><svg width={layout.width} height={layout.height} role="group" aria-label="Cohort dependency graph">
    {layout.edges.map((edge) => <line key={`${edge.from}:${edge.to}`} x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} stroke="currentColor" />)}
    {layout.nodes.map((node) => <g key={node.id} transform={`translate(${node.x},${node.y})`} onClick={() => onSelect(node.id)}
      role="button" tabIndex={0} aria-pressed={node.id === selectedId} onKeyDown={(event) => { if (event.key === "Enter") onSelect(node.id); }} data-testid="or-plan-graph-node">
      <rect width="180" height="70" rx="6" fill="var(--bg-surface)" stroke={node.id === selectedId ? "var(--accent-blue)" : "var(--border-subtle)"} />
      <text x="10" y="25" fill="var(--text-primary)">{node.id.slice(0, 20)}</text>
      <text x="10" y="48" fill="var(--text-secondary)">{node.title.slice(0, 22)}</text>
    </g>)}
  </svg></div>;
}
