import { Handle, Position } from "reactflow";

export interface CohortNodeData {
  label: string;
  priority: number;
  commentCount: number;
  selected?: boolean;
}

export function CohortNode({ data }: { data: CohortNodeData }) {
  return (
    <div className={`cohort-node${data.selected ? " cohort-node--selected" : ""}`}>
      <Handle type="target" position={Position.Top} />
      <div className="cohort-node-title">{data.label}</div>
      <div className="cohort-node-badges">
        {data.priority > 0 && (
          <span className="cohort-node-priority">p{data.priority}</span>
        )}
        {data.commentCount > 0 && (
          <span className="cohort-node-comments">{data.commentCount}</span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
