import { WorkflowDefList } from "../components/organisms/WorkflowDefList";
import type { WorkflowDefSummary } from "../types";

interface WorkflowDefListViewProps {
  onNew: () => void;
  onSelect: (definition: WorkflowDefSummary) => void;
  onClone: (definition: WorkflowDefSummary) => void;
}

export function WorkflowDefListView(props: WorkflowDefListViewProps) {
  return <WorkflowDefList {...props} />;
}
