import type { DefinitionSelection } from "../../../lib/hash";
import type { OperatorDefinitionDetail } from "../../operator-contracts/projections/definition-view";
import type { DefinitionOverview } from "../../lib/definition-overview";
import { selectDefinitionGraph, selectDefinitionNodeLabel, selectDefinitionNodeSelected } from "../../lib/definition-graph";
import { selectDefinitionDependencies, type DependencyEdge } from "../../lib/definition-dependencies";
import { definitionHref, definitionUnitHref } from "../../lib/definition-selection";

interface DefinitionGraphProps {
  definition: OperatorDefinitionDetail;
  selection: DefinitionSelection | null;
  overview: DefinitionOverview;
}
function edgeLabel(edge: DependencyEdge): string {
  return edge.kind === "explicit"
    ? "after"
    : [...new Set(edge.references.map((ref) => ["outcome", ...ref.outcome_path].join(".")))].join(", ");
}
export function DefinitionGraph(props: DefinitionGraphProps) {
  const { definition } = props;
  const { units, edges, layout, breadcrumbs } = selectDefinitionGraph({
    overview: props.overview,
    selection: props.selection,
    dependencies: selectDefinitionDependencies(definition.workflow),
  });
  const id = definition.definition_id;
  return (
    <section aria-label="Definition dependencies">
      <h3>Dependencies</h3>
      <nav aria-label="Graph level">
        <a href={definitionHref(id)}>Root</a>
        {breadcrumbs.map((crumb) => (
          <span key={crumb.path}>
            {" "}
            / <a href={definitionUnitHref(id, crumb.path)}>{crumb.name}</a>
          </span>
        ))}
      </nav>
      <div className="or-definition-graph">
        <svg width={layout.width} height={layout.height} role="img" aria-label="Unit dependency graph">
          <defs>
            <marker
              id="definition-arrow"
              viewBox="0 0 10 10"
              refX="10"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0,0 L10,5 L0,10 Z" fill="currentColor" />
            </marker>
          </defs>
          {edges.map((edge) => {
            const positioned = layout.edges.find((item) => item.from === edge.from && item.to === edge.to);
            const target = layout.nodes.find((node) => node.id === edge.to);
            const source = layout.nodes.find((node) => node.id === edge.from);
            return (
              <g
                key={JSON.stringify([edge.from, edge.to, edge.kind])}
                className={`or-definition-edge or-definition-edge--${edge.kind}`}
                transform={`translate(${edge.offset_x},0)`}
              >
                <path
                  d={positioned?.path}
                  fill="none"
                  stroke="currentColor"
                  markerEnd="url(#definition-arrow)"
                />
                <text
                  x={((source?.x ?? 0) + (target?.x ?? 0)) / 2 + 10}
                  y={((source?.y ?? 0) + 150 + (target?.y ?? 0)) / 2 + (edge.kind === "explicit" ? -6 : 12)}
                >
                  {edgeLabel(edge)}
                </text>
              </g>
            );
          })}
          {layout.nodes.map((node) => {
            const unit = units.find((item) => item.path === node.id);
            if (!unit) return null;
            return (
              <g key={node.id} transform={`translate(${node.x},${node.y})`}>
                <title>{unit.path}{unit.stage ? ` · ${selectDefinitionNodeLabel(unit.stage)}` : ""}</title>
                <rect width={node.width} height={node.height} rx="6" className={`or-definition-node ${selectDefinitionNodeSelected(unit, props.selection) ? "or-definition-node--selected" : ""}`} />
                <a href={definitionUnitHref(id, unit.path)}>
                  <text x="12" y="24">
                    {selectDefinitionNodeLabel(unit.key)}
                    {unit.is_group ? " (group)" : ""}
                  </text>
                </a>
                {unit.stage && (
                  <a href={definitionUnitHref(id, unit.path)}>
                    <text x="12" y="47">
                      {selectDefinitionNodeLabel(unit.stage)}
                    </text>
                  </a>
                )}
                <text x="12" y="70">{unit.for_each !== null ? "collection " : ""}{unit.has_per_member_after ? "per-member after" : ""}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <ul aria-label="Dependency edges">
        {edges.flatMap((edge) =>
          edge.kind === "explicit"
            ? [
                <li key={JSON.stringify(edge)}>
                  <a href={definitionUnitHref(id, edge.to)}>{edge.to}</a> after{" "}
                  <a href={definitionUnitHref(id, edge.from)}>{edge.from}</a>
                </li>,
              ]
            : edge.references.map((ref) => (
                <li key={JSON.stringify(ref)}>
                  <a href={definitionUnitHref(id, ref.downstream)}>{ref.downstream}</a> reads{" "}
                  <a href={definitionUnitHref(id, ref.upstream)}>{ref.upstream}</a>.
                  {["outcome", ...ref.outcome_path].join(".")} via{" "}
                  {ref.binding.kind === "input" ? `input.${ref.binding.field}` : ref.binding.kind}
                </li>
              )),
        )}
      </ul>
    </section>
  );
}
