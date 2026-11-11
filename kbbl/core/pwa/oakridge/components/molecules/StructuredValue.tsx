import { toStructuredNode, type StructuredNode } from "../../lib/structured-value";
import { ExpandableText } from "./ExpandableText";

interface StructuredNodeViewProps { node: StructuredNode }
interface StructuredValueProps { value: unknown }

function StructuredNodeView({ node }: StructuredNodeViewProps) {
  switch (node.kind) {
    case "text": return <ExpandableText text={node.text} className="whitespace-pre-wrap break-words" />;
    case "list": return node.items.length === 0 ? <span>None</span> : (
      <ul className="m-0 list-disc space-y-1 pl-4">{node.items.map((item, index) => <li key={index}><StructuredNodeView node={item} /></li>)}</ul>
    );
    case "section": return node.fields.length === 0 ? <span>No fields recorded.</span> : (
      <dl className="m-0 space-y-1">{node.fields.map(({ label, node: child }, index) => (
        <div key={index}>
          <dt className="font-medium text-[var(--text-muted)]">{label}</dt>
          <dd className="m-0 border-l border-[var(--border-subtle)] pl-3"><StructuredNodeView node={child} /></dd>
        </div>
      ))}</dl>
    );
  }
}

export function StructuredValue({ value }: StructuredValueProps) {
  return <div className="min-w-0 text-xs text-[var(--text-secondary)]"><StructuredNodeView node={toStructuredNode(value)} /></div>;
}
