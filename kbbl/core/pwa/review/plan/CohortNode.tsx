import { Handle, Position } from "reactflow";
import { AtomCommentAffordance } from "../shared/AtomCommentAffordance";
import type { Thread, ReviewMode } from "../shared/types";
import type { Cohort } from "./types";

export interface CohortNodeData {
  cohort: Cohort;
  threads: Thread[];
  mode: ReviewMode;
  frozen: boolean;
  onSelectCohort: (id: string) => void;
  onOpenThread: (anchor: string) => void;
  isSelected: boolean;
  width: number;
  height: number;
}

export function CohortNode({ data }: { data: CohortNodeData }) {
  const { cohort, threads, mode, frozen, onSelectCohort, onOpenThread, isSelected, width, height } =
    data;

  const titleAnchor = `cohorts[${cohort.position}].title`;
  const notesAnchor = `cohorts[${cohort.position}].notes`;

  return (
    <div
      onClick={() => onSelectCohort(cohort.id)}
      className={`cohort-node${isSelected ? " cohort-node--selected" : ""}`}
      style={{ width, height }}
      aria-label={cohort.title}
    >
      {/* ReactFlow Handle — style prop is the documented escape hatch; className not supported for inner SVG element */}
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: "var(--border-subtle)" }}
      />

      <div className="cohort-node__title-row">
        <span className="cohort-node__title" title={cohort.title}>{cohort.title}</span>
        <AtomCommentAffordance
          anchor={titleAnchor}
          threads={threads}
          onOpenThread={onOpenThread}
          frozen={frozen || mode === "edit"}
        />
      </div>

      <div className="cohort-node__bottom-row">
        <span className="cohort-node__status">{cohort.status}</span>
        {cohort.notes && (
          <div className="cohort-node__comments">
            <AtomCommentAffordance
              anchor={notesAnchor}
              threads={threads}
              onOpenThread={onOpenThread}
              frozen={frozen || mode === "edit"}
            />
          </div>
        )}
      </div>

      {/* ReactFlow Handle — style prop is the documented escape hatch; className not supported for inner SVG element */}
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: "var(--border-subtle)" }}
      />
    </div>
  );
}
